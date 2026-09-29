'use strict';
/**
 * Deals: offer → negotiation → acceptance → contract (sections 14–16, 20, 48).
 */
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, badRequest, forbidden, conflict } = require('../lib/errors');
const { requireRole, requireProfile } = require('../lib/auth');
const { STATUS, transition, loadDealFor, participants, computeFees, newDealNumber } = require('../services/dealMachine');
const { notify, escapeHtml } = require('../services/notify');
const { audit } = require('../services/audit');
const { putObject } = require('../services/storage');

const MAX_DELIVERABLES = 30;

/* ---------- Create offer (business) ---------- */
router.post('/', requireRole('business'), wrap(async (req, res) => {
  const app = req.app_;
  const b = req.body || {};
  const creator = await db.one(app, 'CreatorProfiles', `ROWID = ${db.id(b.creator_id, 'creator')}`);
  if (!creator) throw badRequest('Creator not found');
  let campaignId;
  if (b.campaign_id) {
    const c = await db.one(app, 'Campaigns', `ROWID = ${db.id(b.campaign_id)} AND business_id = ${req.business.ROWID}`);
    if (!c) throw badRequest('Campaign not found');
    campaignId = c.ROWID;
  }
  const terms = validateTerms(b);

  const deal = await db.insert(app, 'Deals', {
    deal_number: newDealNumber(),
    business_id: req.business.ROWID,
    creator_id: creator.ROWID,
    campaign_id: campaignId,
    status: STATUS.OFFER_SENT,
    current_offer_version: 1,
    deadline: terms.deadline,
    usage_rights_days: terms.usage_rights_days,
    exclusivity_days: terms.exclusivity_days,
    revision_limit: terms.revision_limit,
    requires_shipping: terms.requires_shipping,
  });
  const offer = await insertOffer(app, deal.ROWID, 1, 'business', terms, b.message);
  if (b.conversation_id) {
    // The offer came out of a direct chat: link them so both sides can see where it started
    try {
      const conv = await db.one(app, 'Conversations', `ROWID = ${db.id(b.conversation_id)} AND business_id = ${req.business.ROWID} AND creator_id = ${creator.ROWID}`);
      if (conv) await db.update(app, 'Conversations', { ROWID: conv.ROWID, status: 'converted', deal_id: deal.ROWID });
    } catch (e) { console.error('link chat to deal failed', e.message); }
  }
  await audit(app, { actor: req.profile, entityType: 'deal', entityId: deal.ROWID, action: 'offer_sent', to: STATUS.OFFER_SENT, details: { total: terms.total_amount }, ip: req.ip });
  await notify(app, creator.user_profile_id, {
    type: 'offer_received', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `New collaboration offer from ${req.business.company_name}`,
    body: `₹${fmt(terms.total_amount)} for ${summarise(terms.deliverables)}`,
  });
  res.status(201).json({ deal, offer });
}));

/* ---------- List my deals ---------- */
router.get('/', requireProfile, wrap(async (req, res) => {
  const app = req.app_;
  const where = [];
  if (req.profile.role === 'business') where.push(`business_id = ${req.business.ROWID}`);
  else if (req.profile.role === 'creator') where.push(`creator_id = ${req.creator.ROWID}`);
  else if (req.profile.role !== 'admin') throw forbidden();
  if (req.query.status) where.push(`status IN ${db.list(String(req.query.status).split(','))}`);
  if (req.query.campaign_id) where.push(`campaign_id = ${db.id(req.query.campaign_id)}`);
  const { page, size, tail } = db.paging(req);
  const deals = await db.select(app, 'Deals', where.join(' AND '), `ORDER BY MODIFIEDTIME DESC ${tail}`);

  const bIds = [...new Set(deals.map((d) => String(d.business_id)))];
  const cIds = [...new Set(deals.map((d) => String(d.creator_id)))];
  const [biz, cre] = await Promise.all([
    bIds.length ? db.select(app, 'BusinessProfiles', `ROWID IN ${db.list(bIds, db.id)}`) : [],
    cIds.length ? db.select(app, 'CreatorProfiles', `ROWID IN ${db.list(cIds, db.id)}`) : [],
  ]);
  res.json({
    page, size,
    data: deals.map((d) => ({
      ...d,
      business: brief(biz.find((x) => String(x.ROWID) === String(d.business_id)), 'business'),
      creator: brief(cre.find((x) => String(x.ROWID) === String(d.creator_id)), 'creator'),
    })),
  });
}));

/* ---------- Full deal view (section 48) ---------- */
router.get('/:id', requireProfile, wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  const did = deal.ROWID;
  const [p, offers, deliverables, submissions, payments, messages, unread, reviews, disputes, timeline, campaign] = await Promise.all([
    participants(app, deal),
    db.select(app, 'OfferVersions', `deal_id = ${did}`, 'ORDER BY version_no ASC'),
    db.select(app, 'Deliverables', `deal_id = ${did}`, 'ORDER BY sequence_no ASC'),
    db.select(app, 'ContentSubmissions', `deal_id = ${did}`, 'ORDER BY CREATEDTIME DESC'),
    db.select(app, 'Payments', `deal_id = ${did}`, 'ORDER BY CREATEDTIME DESC'),
    db.count(app, 'Messages', `deal_id = ${did}`),
    side === 'admin' ? 0 : db.count(app, 'Messages', `deal_id = ${did} AND is_read = false AND sender_profile_id != ${req.profile.ROWID}`),
    db.select(app, 'Reviews', `deal_id = ${did}`),
    db.select(app, 'Disputes', `deal_id = ${did}`),
    db.select(app, 'AuditLogs', `entity_type = 'deal' AND entity_id = ${did}`, 'ORDER BY CREATEDTIME ASC LIMIT 0, 200'),
    deal.campaign_id ? db.one(app, 'Campaigns', `ROWID = ${db.id(deal.campaign_id)}`) : null,
  ]);
  const latest = offers[offers.length - 1];
  res.json({
    deal, side,
    business: brief(p.business, 'business'),
    creator: brief(p.creator, 'creator'),
    campaign: campaign ? { id: campaign.ROWID, name: campaign.name, brief: campaign.brief } : null,
    offers: offers.map(parseOffer),
    pending_offer: latest && latest.status === 'pending' ? parseOffer(latest) : null,
    can_respond: Boolean(latest && latest.status === 'pending' && side !== 'admin' && latest.proposed_by !== side),
    deliverables: deliverables.map((d) => ({ ...d, metrics: safeJson(d.metrics_json) })),
    submissions,
    payments: payments.map(({ gateway_transfer_id, ...x }) => x),
    messages: { total: messages, unread },
    reviews, disputes,
    fees: deal.agreed_amount ? computeFees(deal.agreed_amount) : null,
    timeline: timeline.map((t) => ({ at: t.CREATEDTIME, by: t.actor_role, action: t.action, from: t.from_status, to: t.to_status })),
  });
}));

/* ---------- Counter offer (either side) ---------- */
router.post('/:id/counter', requireRole('business', 'creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  if (![STATUS.OFFER_SENT, STATUS.NEGOTIATION].includes(deal.status)) throw conflict('This deal is no longer open for negotiation');
  const latest = await latestOffer(app, deal.ROWID);
  if (latest && latest.proposed_by === side && latest.status === 'pending') throw conflict('Wait for the other party to respond to your last offer');

  // Start from the previous terms so a counter can change just the price
  const base = latest ? parseOffer(latest) : {};
  const terms = validateTerms({
    revision_limit: deal.revision_limit, requires_shipping: String(deal.requires_shipping) === 'true',
    ...base, ...req.body,
    deliverables: req.body.deliverables || base.deliverables,
    price_breakdown: req.body.price_breakdown || base.price_breakdown,
  });
  if (latest && latest.status === 'pending') await db.update(app, 'OfferVersions', { ROWID: latest.ROWID, status: 'countered' });
  const v = (Number(deal.current_offer_version) || 0) + 1;
  const offer = await insertOffer(app, deal.ROWID, v, side, terms, req.body.message);
  await transition(app, deal, STATUS.NEGOTIATION, { actor: req.profile, extra: { current_offer_version: v, revision_limit: terms.revision_limit, requires_shipping: terms.requires_shipping }, details: { version: v, total: terms.total_amount }, ip: req.ip });

  const p = await participants(app, deal);
  await notify(app, side === 'business' ? p.creatorUserId : p.businessUserId, {
    type: 'counter_offer', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `Counter offer on ${deal.deal_number}`, body: `New proposal: ₹${fmt(terms.total_amount)}`,
  });
  res.json({ offer: parseOffer(offer) });
}));

/* ---------- Accept the pending offer ---------- */
router.post('/:id/accept', requireRole('business', 'creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  if (![STATUS.OFFER_SENT, STATUS.NEGOTIATION].includes(deal.status)) throw conflict('Nothing to accept on this deal');
  const latest = await latestOffer(app, deal.ROWID);
  if (!latest || latest.status !== 'pending') throw conflict('There is no pending offer');
  if (latest.proposed_by === side) throw conflict('You cannot accept your own offer');

  const terms = parseOffer(latest);
  const fees = computeFees(terms.total_amount);
  await db.update(app, 'OfferVersions', { ROWID: latest.ROWID, status: 'accepted' });

  // Create one Deliverables row per unit (e.g. 2 Reels → 2 rows) so each can be submitted/approved separately
  const rows = [];
  let seq = 1;
  for (const d of terms.deliverables) {
    for (let i = 0; i < d.quantity; i += 1) {
      rows.push({ deal_id: deal.ROWID, platform: d.platform, content_type: d.content_type, sequence_no: seq++,
        requirements: d.requirements, due_date: d.due_date || terms.deadline, status: 'pending' });
    }
  }
  if (rows.length) await db.insertMany(app, 'Deliverables', rows);

  const updated = await transition(app, deal, STATUS.ACCEPTED, {
    actor: req.profile, ip: req.ip, details: { version: latest.version_no, total: terms.total_amount },
    extra: {
      agreed_amount: fees.agreed, platform_fee: fees.platformFee, creator_payout: fees.creatorPayout,
      deadline: terms.deadline, usage_rights_days: terms.usage_rights_days, exclusivity_days: terms.exclusivity_days,
    },
  });
  if (deal.campaign_id) await refreshCampaignCommitted(app, deal.campaign_id);

  const p = await participants(app, deal);
  await notify(app, side === 'business' ? p.creatorUserId : p.businessUserId, {
    type: 'offer_accepted', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `Offer accepted — ${deal.deal_number}`, body: `₹${fmt(fees.agreed)} agreed. Next step: sign the agreement.`,
  });
  res.json({ deal: updated, fees });
}));

/* ---------- Reject / cancel ---------- */
router.post('/:id/reject', requireRole('business', 'creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  if (![STATUS.OFFER_SENT, STATUS.NEGOTIATION].includes(deal.status)) throw conflict('This deal can no longer be rejected');
  const latest = await latestOffer(app, deal.ROWID);
  if (latest && latest.status === 'pending') await db.update(app, 'OfferVersions', { ROWID: latest.ROWID, status: 'rejected' });
  const updated = await transition(app, deal, STATUS.REJECTED, { actor: req.profile, details: { reason: req.body.reason }, ip: req.ip });
  const p = await participants(app, deal);
  await notify(app, side === 'business' ? p.creatorUserId : p.businessUserId, {
    type: 'offer_rejected', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `Offer declined — ${deal.deal_number}`, body: req.body.reason || 'The other party declined this offer.',
  });
  res.json({ deal: updated });
}));

router.post('/:id/cancel', requireRole('business', 'creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  const allowed = [STATUS.OFFER_SENT, STATUS.NEGOTIATION, STATUS.ACCEPTED, STATUS.CONTRACT_SIGNED];
  if (!allowed.includes(deal.status)) throw conflict('Once payment is secured, cancellation goes through a dispute');
  const updated = await transition(app, deal, STATUS.CANCELLED, { actor: req.profile, details: { reason: req.body.reason }, ip: req.ip });
  if (deal.campaign_id) await refreshCampaignCommitted(app, deal.campaign_id);
  const p = await participants(app, deal);
  await notify(app, side === 'business' ? p.creatorUserId : p.businessUserId, {
    type: 'deal_cancelled', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: `Deal cancelled — ${deal.deal_number}`, body: req.body.reason || '',
  });
  res.json({ deal: updated });
}));

/* ---------- Agreement (section 20) ---------- */
router.get('/:id/contract', requireProfile, wrap(async (req, res) => {
  const { deal } = await loadDealFor(req, req.params.id);
  if ([STATUS.OFFER_SENT, STATUS.NEGOTIATION, STATUS.REJECTED].includes(deal.status)) throw conflict('The agreement is generated after an offer is accepted');
  const html = await buildContract(req.app_, deal);
  res.type('html').send(html);
}));

router.post('/:id/sign', requireRole('business', 'creator'), wrap(async (req, res) => {
  const app = req.app_;
  const { deal, side } = await loadDealFor(req, req.params.id);
  if (deal.status !== STATUS.ACCEPTED) throw conflict('This deal is not waiting for signatures');
  if (req.body.agree !== true) throw badRequest('Please confirm you agree to the terms');
  const col = side === 'business' ? 'business_signed_at' : 'creator_signed_at';
  if (deal[col]) throw conflict('You have already signed');

  const signedAt = db.now();
  const row = { ROWID: deal.ROWID, [col]: signedAt };
  await db.update(app, 'Deals', row);
  await audit(app, { actor: req.profile, entityType: 'deal', entityId: deal.ROWID, action: `signed_by_${side}`, details: { ip: req.ip, ua: req.get('user-agent') }, ip: req.ip });
  const fresh = { ...deal, [col]: signedAt };

  let result = fresh;
  if (fresh.business_signed_at && fresh.creator_signed_at) {
    const html = await buildContract(app, fresh);
    const key = `contracts/${deal.ROWID}/agreement-${deal.deal_number}.html`;
    try { await putObject(app, process.env.DOCS_BUCKET, key, Buffer.from(html), 'text/html'); } catch (e) { console.error('contract store failed', e.message); }
    result = await transition(app, fresh, STATUS.CONTRACT_SIGNED, { actor: req.profile, extra: { contract_url: key }, ip: req.ip });
  }
  const p = await participants(app, deal);
  await notify(app, side === 'business' ? p.creatorUserId : p.businessUserId, {
    type: 'contract_signed', dealId: deal.ROWID, link: `/deals/${deal.ROWID}`,
    title: result.status === STATUS.CONTRACT_SIGNED ? `Agreement fully signed — ${deal.deal_number}` : `Please sign the agreement — ${deal.deal_number}`,
    body: result.status === STATUS.CONTRACT_SIGNED ? 'Next step: the business secures payment.' : 'The other party has signed.',
  });
  res.json({ deal: result });
}));

/* ---------- helpers ---------- */
function validateTerms(b) {
  const deliverables = Array.isArray(b.deliverables) ? b.deliverables : [];
  if (!deliverables.length) throw badRequest('Add at least one deliverable');
  const clean = deliverables.map((d) => {
    const quantity = parseInt(d.quantity || 1, 10);
    if (!d.platform || !d.content_type) throw badRequest('Each deliverable needs a platform and content type');
    if (!(quantity >= 1 && quantity <= 20)) throw badRequest('Quantity must be between 1 and 20');
    return { platform: String(d.platform), content_type: String(d.content_type), quantity,
      requirements: d.requirements ? String(d.requirements).slice(0, 2000) : undefined, due_date: d.due_date || undefined };
  });
  if (clean.reduce((a, d) => a + d.quantity, 0) > MAX_DELIVERABLES) throw badRequest(`Maximum ${MAX_DELIVERABLES} pieces of content per deal`);

  const breakdown = Array.isArray(b.price_breakdown) ? b.price_breakdown.map((x) => ({ label: String(x.label || '').slice(0, 80), amount: db.num(x.amount, 'amount') })) : [];
  const total = breakdown.length ? breakdown.reduce((a, x) => a + x.amount, 0) : db.num(b.total_amount, 'total amount');
  if (!(total > 0)) throw badRequest('Total amount must be more than zero');
  if (b.total_amount !== undefined && breakdown.length && Math.abs(Number(b.total_amount) - total) > 0.01) {
    throw badRequest('Total amount does not match the price breakdown');
  }
  const deadline = b.deadline ? String(b.deadline).slice(0, 10) : undefined;
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw badRequest('Deadline must be YYYY-MM-DD');
  if (deadline && deadline < db.today()) throw badRequest('Deadline cannot be in the past');
  return {
    deliverables: clean,
    price_breakdown: breakdown,
    total_amount: Math.round(total * 100) / 100,
    deadline,
    usage_rights_days: clampInt(b.usage_rights_days, 0, 3650),
    exclusivity_days: clampInt(b.exclusivity_days, 0, 365),
    revision_limit: b.revision_limit === undefined ? 2 : clampInt(b.revision_limit, 0, 10),
    requires_shipping: b.requires_shipping === true || b.requires_shipping === 'true',
    brief: b.brief ? String(b.brief).slice(0, 9000) : undefined,
  };
}
const clampInt = (v, min, max) => Math.min(max, Math.max(min, parseInt(v || 0, 10) || 0));

function insertOffer(app, dealId, version, side, t, message) {
  return db.insert(app, 'OfferVersions', {
    deal_id: dealId, version_no: version, proposed_by: side,
    deliverables_json: JSON.stringify(t.deliverables),
    price_breakdown_json: JSON.stringify(t.price_breakdown),
    total_amount: t.total_amount, deadline: t.deadline,
    usage_rights_days: t.usage_rights_days, exclusivity_days: t.exclusivity_days,
    brief: t.brief, message: message ? String(message).slice(0, 2000) : undefined, status: 'pending',
  });
}

async function latestOffer(app, dealId) {
  const r = await db.select(app, 'OfferVersions', `deal_id = ${db.id(dealId)}`, 'ORDER BY version_no DESC LIMIT 0, 1');
  return r[0] || null;
}

function parseOffer(o) {
  return {
    id: o.ROWID, version: Number(o.version_no), proposed_by: o.proposed_by, status: o.status, created: o.CREATEDTIME,
    deliverables: safeJson(o.deliverables_json) || [], price_breakdown: safeJson(o.price_breakdown_json) || [],
    total_amount: Number(o.total_amount), deadline: o.deadline, usage_rights_days: Number(o.usage_rights_days) || 0,
    exclusivity_days: Number(o.exclusivity_days) || 0, brief: o.brief, message: o.message,
  };
}
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

function brief(x, type) {
  if (!x) return null;
  return type === 'business'
    ? { id: x.ROWID, company_name: x.company_name, logo_url: x.logo_url, category: x.category, verification_status: x.verification_status, avg_rating: x.avg_rating }
    : { id: x.ROWID, full_name: x.full_name, username: x.username, photo_url: x.photo_url, total_followers: x.total_followers, is_verified: x.is_verified, avg_rating: x.avg_rating };
}

async function refreshCampaignCommitted(app, campaignId) {
  const total = await db.sum(app, 'Deals', 'agreed_amount',
    `campaign_id = ${db.id(campaignId)} AND status NOT IN ('rejected','cancelled','offer_sent','negotiation')`);
  await db.update(app, 'Campaigns', { ROWID: campaignId, committed_amount: total });
}

const fmt = (n) => Number(n).toLocaleString('en-IN');
const summarise = (items) => items.map((d) => `${d.quantity} × ${d.platform} ${d.content_type.replace(/_/g, ' ')}`).join(', ');

async function buildContract(app, deal) {
  const p = await participants(app, deal);
  const offers = await db.select(app, 'OfferVersions', `deal_id = ${deal.ROWID} AND status = 'accepted'`, 'ORDER BY version_no DESC LIMIT 0, 1');
  const t = offers[0] ? parseOffer(offers[0]) : { deliverables: [], price_breakdown: [] };
  const fees = computeFees(deal.agreed_amount);
  const e = escapeHtml;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agreement ${e(deal.deal_number)}</title>
<style>body{font-family:Georgia,serif;max-width:760px;margin:40px auto;line-height:1.55;color:#222;padding:0 16px}h1{font-size:22px}h2{font-size:16px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 8px;text-align:left}small{color:#666}</style></head><body>
<h1>Creator Collaboration Agreement</h1>
<p><b>Deal:</b> ${e(deal.deal_number)} &nbsp; <b>Generated:</b> ${e(db.now())} IST</p>
<h2>1. Parties</h2>
<p><b>Business:</b> ${e(p.business.company_name)}${p.business.gstin ? ` (GSTIN ${e(p.business.gstin)})` : ''}, ${e(p.business.city || '')} ${e(p.business.country || '')}<br>
<b>Creator:</b> ${e(p.creator.full_name)} (@${e(p.creator.username)}), ${e(p.creator.city || '')} ${e(p.creator.country || '')}<br>
<b>Platform:</b> Brandfluence, acting as the marketplace and payment facilitator.</p>
<h2>2. Deliverables</h2>
<table><tr><th>Platform</th><th>Content</th><th>Qty</th><th>Requirements</th></tr>
${t.deliverables.map((d) => `<tr><td>${e(d.platform)}</td><td>${e(d.content_type)}</td><td>${d.quantity}</td><td>${e(d.requirements || '')}</td></tr>`).join('')}</table>
<p><b>Deadline:</b> ${e(deal.deadline || 'As agreed in chat')}</p>
${t.brief ? `<p><b>Brief:</b> ${e(t.brief)}</p>` : ''}
<h2>3. Fees and payment</h2>
<table>${t.price_breakdown.map((x) => `<tr><td>${e(x.label)}</td><td>₹${fmt(x.amount)}</td></tr>`).join('')}
<tr><th>Agreed fee</th><th>₹${fmt(fees.agreed)}</th></tr><tr><td>Creator payout</td><td>₹${fmt(fees.creatorPayout)}</td></tr></table>
<p>The Business pays the agreed fee plus platform fees through Brandfluence before work starts. Funds are held and released to the Creator after the Business approves the content (or automatically ${e(process.env.AUTO_RELEASE_DAYS || 7)} days after all content is published, unless a dispute is raised).</p>
<h2>4. Usage rights and exclusivity</h2>
<p>Usage rights: ${Number(deal.usage_rights_days) || 0} days from publication, for the Business's own channels${Number(deal.usage_rights_days) ? '' : ' (organic sharing only)'}.<br>
Exclusivity: the Creator will not promote directly competing brands for ${Number(deal.exclusivity_days) || 0} days after publication.</p>
<h2>5. Approval and revisions</h2>
<p>The Creator submits drafts through Brandfluence before publishing. The Business may request up to ${Number(deal.revision_limit) || 0} revision(s) per deliverable. Further revisions require additional payment.</p>
<h2>6. Disclosure</h2>
<p>The Creator will clearly disclose the paid partnership (e.g. "#ad", "Paid partnership" label) in line with ASCI guidelines and applicable law.</p>
<h2>7. Intellectual property</h2>
<p>The Creator retains ownership of the content and grants the Business the usage rights in Section 4.</p>
<h2>8. Cancellation and disputes</h2>
<p>Before payment is secured, either party may cancel. After that, issues are raised as a dispute on Brandfluence; an administrator reviews the evidence (agreement, chat, submissions, approval and payment history) and may release, refund or partially settle held funds.</p>
<h2>9. Signatures</h2>
<p>Business signed: ${e(deal.business_signed_at || 'pending')}<br>Creator signed: ${e(deal.creator_signed_at || 'pending')}</p>
<p><small>Electronically accepted on Brandfluence. Signing time, account and IP address are recorded in the deal audit log.</small></p>
</body></html>`;
}

module.exports = router;
module.exports.parseOffer = parseOffer;
module.exports.safeJson = safeJson;
