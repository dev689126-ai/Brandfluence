import { get, post, put, qs, upload, fileUrl, BASE } from '../api.js';
import { $, $$, esc, inr, compact, label, date, tag, toast, fail, modal, confirmBox, formData, busy, field, select, emptyState, avatar, isTrue } from '../ui.js';
import { ctx, go } from '../state.js';

const main = () => $('#main');
let chatTimer = null;
window.addEventListener('hashchange', () => { clearInterval(chatTimer); chatTimer = null; });

/* ---------------- Lists ---------------- */
export function dealRows(list) {
  return `<div class="rows">${list.map((d) => {
    const other = ctx.role === 'creator' ? (d.business && d.business.company_name) : (d.creator && `${d.creator.full_name} (@${d.creator.username})`);
    return `<a class="row" href="#/deals/${d.ROWID}"><div><div class="t">${esc(other || d.deal_number)}</div><div class="s">${esc(d.deal_number)} · ${d.agreed_amount ? inr(d.agreed_amount) : 'Price in negotiation'} · Updated ${date(d.MODIFIEDTIME)}</div></div>${tag(d.status)}</a>`;
  }).join('')}</div>`;
}

const FILTERS = [
  ['', 'All'], ['offer_sent,negotiation', 'Offers'], ['accepted,contract_signed', 'To sign or pay'],
  ['payment_secured,in_progress,content_submitted,revision_requested,approved', 'In progress'],
  ['published,completed', 'Live and done'], ['disputed', 'Disputed'], ['rejected,cancelled', 'Closed'],
];
export async function dealList() {
  const current = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || '';
  const { data } = await get('/deals' + qs({ status: current, size: 100 }));
  main().innerHTML = `
    <div class="page-head"><div><h1>Deals</h1><p>Every collaboration, from offer to payout.</p></div>${ctx.role === 'business' ? '<a class="btn" href="#/discover">Find creators</a>' : ''}</div>
    <nav class="tabs">${FILTERS.map(([v, t]) => `<a href="#/deals${v ? '?status=' + v : ''}" data-f="${v}" class="${v === current ? 'active' : ''}">${t}</a>`).join('')}</nav>
    ${data.length ? dealRows(data) : `<div class="rows">${emptyState(current ? 'No deals in this group.' : ctx.role === 'creator' ? 'No deals yet. Offers from brands will show up here.' : 'No deals yet.')}</div>`}`;
  $$('[data-f]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); history.replaceState(null, '', a.getAttribute('href')); dealList(); }; });
}

/* ---------------- Deal page ---------------- */
const STOPS = [
  ['Offer', ['offer_sent', 'negotiation']], ['Agreed', ['accepted']], ['Signed', ['contract_signed']], ['Paid in', ['payment_secured']],
  ['Creating', ['in_progress']], ['Review', ['content_submitted', 'revision_requested']], ['Approved', ['approved']], ['Live', ['published']], ['Paid out', ['completed']],
];

function journey(status, timeline) {
  let idx = STOPS.findIndex(([, s]) => s.includes(status));
  let off = false;
  if (idx === -1) { // disputed / rejected / cancelled → mark the last reached stage
    off = true;
    const reached = timeline.map((t) => t.from).filter(Boolean).map((s) => STOPS.findIndex(([, st]) => st.includes(s)));
    idx = Math.max(0, ...reached);
  }
  const offLabel = { disputed: 'Disputed', rejected: 'Declined', cancelled: 'Cancelled' }[status];
  return `<div class="journey drawing ${off ? "off" : ""}" aria-label="Deal progress">${STOPS.map(([name], i) =>
    `<div class="stop ${i < idx ? 'done' : i === idx ? 'now' : ''}" ${i === idx ? 'aria-current="step"' : ''}><div class="dot"></div>${i === idx && off ? offLabel : name}</div>`).join('')}</div>`;
}

export async function dealPage(id) {
  const r = await get('/deals/' + id);
  const { deal, side } = r;
  const other = side === 'creator' ? r.business : r.creator;
  const otherName = side === 'creator' ? r.business.company_name : r.creator.full_name;
  const accepted = r.offers.filter((o) => o.status === 'accepted').pop();
  const terms = accepted || r.pending_offer || r.offers[r.offers.length - 1];

  main().innerHTML = `
    <div class="page-head">
      <div><div class="muted small">${esc(deal.deal_number)}${r.campaign ? ` · <a href="#/campaigns/${r.campaign.id}">${esc(r.campaign.name)}</a>` : ''}</div>
        <h1>${side === 'admin' ? `${esc(r.business.company_name)} × ${esc(r.creator.full_name)}` : `${side === 'creator' ? 'Deal with ' : 'Deal with '}${esc(otherName)}`}</h1>
        <p>${tag(deal.status)} ${deal.agreed_amount ? `<b style="margin-left:6px">${inr(deal.agreed_amount)}</b> agreed` : terms ? `${inr(terms.total_amount)} proposed` : ''}</p></div>
      <div class="btn-row">${side !== 'admin' && other ? `<a class="btn secondary" href="${side === 'business' ? '#/creators/' + other.id : '#'}" ${side === 'creator' ? 'id="view-biz"' : ''}>View ${side === 'business' ? 'creator' : 'brand'}</a>` : ''}</div>
    </div>
    ${journey(deal.status, r.timeline)}
    <div id="next"></div>
    <div class="cols">
      <div>
        <div id="deliverables"></div>
        <div class="panel" id="terms-panel"></div>
        <div class="panel" id="history"></div>
      </div>
      <div>
        <div class="panel"><div class="panel-head"><h3>Messages</h3>${r.messages.unread ? `<span class="tag gold">${r.messages.unread} new</span>` : ''}</div><div class="chat" id="chat"></div></div>
        <div class="panel" id="money"></div>
        <div class="panel"><h3>Agreement</h3>${agreementBlock(deal)}</div>
      </div>
    </div>`;
  const vb = $('#view-biz');
  if (vb) vb.onclick = (e) => { e.preventDefault(); businessCard(r.business.id); };

  renderNext(r);
  renderTerms(r, terms);
  renderDeliverables(r);
  renderMoney(r);
  renderHistory(r);
  initChat(deal.ROWID, side);
  $$('[data-contract]').forEach((b) => { b.onclick = () => showContract(deal.ROWID); });
}

function agreementBlock(deal) {
  if (['offer_sent', 'negotiation', 'rejected'].includes(deal.status)) return '<p class="small muted">Generated when an offer is accepted.</p>';
  return `<p class="small">Brand signed: ${deal.business_signed_at ? date(deal.business_signed_at, true) : '<span class="muted">not yet</span>'}<br>Creator signed: ${deal.creator_signed_at ? date(deal.creator_signed_at, true) : '<span class="muted">not yet</span>'}</p><button class="btn secondary small" data-contract>Read agreement</button>`;
}

/* The single most important action for this person right now */
function renderNext(r) {
  const { deal, side } = r;
  const box = $('#next');
  const s = deal.status;
  const them = side === 'creator' ? 'the brand' : 'the creator';
  let html = '';
  const days = 7;

  if (side === 'admin') html = `<div class="next-step"><h3>Admin view</h3><p>You're seeing this deal as an administrator.</p></div>`;
  else if (['offer_sent', 'negotiation'].includes(s)) {
    html = r.can_respond
      ? `<div class="next-step"><h3>${side === 'creator' ? 'You have an offer' : 'The creator replied with new terms'}</h3><p>${inr(r.pending_offer.total_amount)} for ${esc(summary(r.pending_offer.deliverables))}. Accept it, propose different terms, or decline.</p>
         <div class="btn-row"><button class="btn money" id="accept">Accept offer</button><button class="btn secondary" id="counter">Propose changes</button><button class="btn ghost" id="reject">Decline</button></div></div>`
      : `<div class="next-step"><h3>Waiting for ${them} to respond</h3><p>We'll notify you when they accept or reply.</p><button class="btn ghost small" id="cancel">Withdraw offer</button></div>`;
  } else if (s === 'accepted') {
    const mine = side === 'business' ? deal.business_signed_at : deal.creator_signed_at;
    html = mine
      ? `<div class="next-step"><h3>Waiting for ${them} to sign</h3><p>You've signed. Once both sides sign, ${side === 'business' ? 'you can secure payment' : 'the brand secures payment'}.</p></div>`
      : `<div class="next-step"><h3>Sign the agreement</h3><p>It sets out the content, price, dates, usage rights and how payment is released.</p><div class="btn-row"><button class="btn secondary" data-contract>Read agreement</button><button class="btn money" id="sign">Sign agreement</button><button class="btn ghost" id="cancel">Cancel deal</button></div></div>`;
  } else if (s === 'contract_signed') {
    html = side === 'business'
      ? `<div class="next-step"><h3>Secure payment to start the work</h3><p>You pay ${inr(r.fees.businessPays)} now. It's held by Razorpay and only released to the creator after you approve the content.</p><button class="btn money" id="pay">Pay ${inr(r.fees.businessPays)} securely</button></div>`
      : `<div class="next-step"><h3>Waiting for the brand to secure payment</h3><p>Don't start work until this step is done. ${ctx.me.creator && !ctx.me.creator.payouts_ready ? '<b>Your payout account isn\'t set up yet, so the brand can\'t pay.</b> <a href="#/profile/payout">Set it up now</a>.' : ''}</p></div>`;
  } else if (s === 'payment_secured') {
    html = side === 'creator'
      ? `<div class="next-step"><h3>Payment is secured. You can start.</h3><p>${isTrue(deal.requires_shipping) ? 'Confirm when you receive the product, then create your content and upload drafts below.' : 'Create your content and upload drafts below for approval before posting.'}</p><button class="btn money" id="start">${isTrue(deal.requires_shipping) ? 'I received the product' : 'Start working'}</button></div>`
      : `<div class="next-step"><h3>Payment secured</h3><p>The creator has been told to start. ${isTrue(deal.requires_shipping) ? 'Ship the product and share tracking details in the chat.' : 'Drafts will appear below for your approval.'}</p></div>`;
  } else if (['in_progress', 'revision_requested'].includes(s)) {
    html = side === 'creator'
      ? `<div class="next-step"><h3>${s === 'revision_requested' ? 'The brand asked for changes' : 'Upload your drafts'}</h3><p>Submit each piece below for approval. Don't publish until it's approved.</p></div>`
      : `<div class="next-step"><h3>The creator is working on it</h3><p>You'll be notified when drafts are ready.</p></div>`;
  } else if (s === 'content_submitted') {
    html = side === 'business'
      ? `<div class="next-step"><h3>Content is waiting for your review</h3><p>Approve it or ask for changes below. You have ${Number(deal.revision_limit) || 0} revision round(s) per piece in the agreement.</p></div>`
      : `<div class="next-step"><h3>In review</h3><p>The brand is reviewing your content.</p></div>`;
  } else if (s === 'approved') {
    html = side === 'creator'
      ? `<div class="next-step"><h3>Approved. Publish it now.</h3><p>Post the approved content, then paste each live link below. Remember the paid-partnership label.</p></div>`
      : `<div class="next-step"><h3>All content approved</h3><p>The creator will publish and share live links. You can release payment now or after it's live.</p><button class="btn secondary" id="release">Release payment now</button></div>`;
  } else if (s === 'published') {
    html = side === 'business'
      ? `<div class="next-step"><h3>Content is live. Release the payment.</h3><p>If you don't release it or raise a dispute within ${days} days of going live, the payment is released automatically.</p><div class="btn-row"><button class="btn money" id="release">Release ${inr(deal.creator_payout)} to creator</button><button class="btn ghost" id="dispute">Report a problem</button></div></div>`
      : `<div class="next-step"><h3>Content is live</h3><p>Payment is released when the brand confirms, or automatically ${days} days after going live. Add your results below.</p></div>`;
  } else if (s === 'completed') {
    const mine = r.reviews.find((x) => x.reviewer_role === side);
    html = mine ? `<div class="next-step"><h3>Deal completed</h3><p>Thanks for working through Brandfluence.</p></div>`
      : `<div class="next-step"><h3>Deal completed. Leave a review.</h3><p>Reviews help good ${side === 'business' ? 'creators get more work' : 'brands find creators'}.</p><button class="btn money" id="review">Review ${side === 'business' ? 'the creator' : 'the brand'}</button></div>`;
  } else if (s === 'disputed') {
    html = `<div class="next-step rose"><h3>Dispute under review</h3><p>Payment is on hold. Our team is reviewing the agreement, chat, submissions and history, and may contact you in the chat. Add anything relevant there.</p></div>`;
  } else {
    html = `<div class="next-step"><h3>This deal is closed</h3><p>${s === 'rejected' ? 'The offer was declined.' : 'The deal was cancelled.'}</p></div>`;
  }
  const canDispute = ['payment_secured', 'in_progress', 'content_submitted', 'revision_requested', 'approved'].includes(s) && side !== 'admin';
  box.innerHTML = html + (canDispute ? '<p class="small" style="margin:-10px 0 18px"><button class="btn ghost small" id="dispute">Report a problem with this deal</button></p>' : '');

  const id = r.deal.ROWID;
  const on = (sel, fn) => { const b = $(sel, box); if (b) b.onclick = busy(b, fn); };
  on('#accept', async () => {
    if (!(await confirmBox('Accept this offer?', `You're agreeing to ${summary(r.pending_offer.deliverables)} for ${inr(r.pending_offer.total_amount)}. Next, both sides sign the agreement.`, 'Accept offer'))) return;
    await post(`/deals/${id}/accept`); toast('Offer accepted'); go('#/deals/' + id);
  });
  on('#counter', async () => openOfferModal({ title: 'Propose changes', initial: r.pending_offer, counter: true,
    onSubmit: async (t) => { await post(`/deals/${id}/counter`, t); toast('Counter offer sent'); go('#/deals/' + id); } }));
  on('#reject', async () => {
    const m = modal('Decline this offer?', `<form id="rj">${field('reason', 'Reason (optional, shared with them)', { type: 'textarea' })}<button class="btn danger" type="submit">Decline offer</button></form>`);
    $('#rj', m.el).onsubmit = async (e) => { e.preventDefault(); try { await post(`/deals/${id}/reject`, formData(e.target)); m.close(); toast('Offer declined'); go('#/deals/' + id); } catch (err) { fail(err); } };
  });
  on('#cancel', async () => { if (await confirmBox('Cancel this deal?', 'The other side will be notified. This can\'t be undone.', 'Cancel deal', true)) { await post(`/deals/${id}/cancel`); go('#/deals/' + id); } });
  on('#sign', async () => signModal(id));
  on('#pay', async () => pay(id));
  on('#start', async () => { await post(`/deals/${id}/start`, { product_received: isTrue(r.deal.requires_shipping) }); go('#/deals/' + id); });
  on('#release', async () => { if (await confirmBox('Release payment?', `${inr(r.deal.creator_payout)} will be sent to the creator. This can't be undone.`, 'Release payment')) { await post(`/deals/${id}/release`); toast('Payment released'); go('#/deals/' + id); } });
  on('#review', async () => reviewModal(id, side));
  const dBtn = $('#dispute', box);
  if (dBtn) dBtn.onclick = () => disputeModal(id);
}

const plural = (w, n) => (n > 1 ? (w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's') : w);
const summary = (items) => (items || []).map((d) => `${d.quantity} ${label(d.platform)} ${plural(label(d.content_type).toLowerCase(), d.quantity)}`).join(', ');

function renderTerms(r, t) {
  const p = $('#terms-panel');
  if (!t) { p.innerHTML = '<h3>Terms</h3><p class="muted">No offer yet.</p>'; return; }
  p.innerHTML = `
    <div class="panel-head"><h3>${t.status === 'accepted' ? 'Agreed terms' : `Offer v${t.version} from the ${t.proposed_by === 'business' ? 'brand' : 'creator'}`}</h3>${tag(t.status === 'pending' ? 'negotiation' : t.status === 'accepted' ? 'accepted' : t.status)}</div>
    <table class="data"><thead><tr><th>Platform</th><th>Content</th><th>Qty</th><th>Requirements</th></tr></thead><tbody>
      ${t.deliverables.map((d) => `<tr><td>${esc(label(d.platform))}</td><td>${esc(label(d.content_type))}</td><td>${d.quantity}</td><td class="small">${esc(d.requirements || '—')}</td></tr>`).join('')}</tbody></table>
    <div class="grid-2" style="margin-top:14px">
      <div><table class="lines">${t.price_breakdown.map((x) => `<tr><td>${esc(x.label)}</td><td>${inr(x.amount)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td>${inr(t.total_amount)}</td></tr></table></div>
      <div class="small"><p style="margin:0 0 6px"><b>Deadline:</b> ${date(t.deadline)}</p><p style="margin:0 0 6px"><b>Usage rights:</b> ${t.usage_rights_days ? t.usage_rights_days + ' days' : 'Organic sharing only'}</p>
        <p style="margin:0 0 6px"><b>Exclusivity:</b> ${t.exclusivity_days ? t.exclusivity_days + ' days, no competing brands' : 'None'}</p><p style="margin:0 0 6px"><b>Revisions:</b> ${Number(r.deal.revision_limit) || 0} per piece</p>
        ${isTrue(r.deal.requires_shipping) ? '<p style="margin:0"><b>Product will be shipped</b></p>' : ''}</div>
    </div>
    ${t.brief ? `<h3 style="margin-top:16px">Brief</h3><p style="white-space:pre-wrap">${esc(t.brief)}</p>` : ''}
    ${t.message ? `<p class="small muted">Note: “${esc(t.message)}”</p>` : ''}`;
}

function renderHistory(r) {
  const p = $('#history');
  const offers = r.offers.length > 1 ? `<h3>Negotiation</h3><table class="data" style="margin-bottom:16px"><tbody>${r.offers.map((o) => `<tr><td>v${o.version}</td><td>${o.proposed_by === 'business' ? 'Brand' : 'Creator'}</td><td>${inr(o.total_amount)}</td><td>${esc(summary(o.deliverables))}</td><td>${tag(o.status === 'pending' ? 'negotiation' : o.status)}</td><td class="small muted">${date(o.created, true)}</td></tr>`).join('')}</tbody></table>` : '';
  p.innerHTML = `${offers}<h3>History</h3>${r.timeline.map((t) => `<div class="small" style="padding:4px 0"><span class="muted">${date(t.at, true)}</span> — ${esc(label(t.by || 'system'))}: ${esc(label(t.action))}${t.to ? ` → ${esc(label(t.to))}` : ''}</div>`).join('') || '<p class="muted small">No activity yet.</p>'}`;
}

function renderMoney(r) {
  const p = $('#money');
  const f = r.fees;
  if (!f) { p.innerHTML = '<h3>Payment</h3><p class="small muted">Shown once terms are agreed.</p>'; return; }
  const pay = r.payments.find((x) => x.payment_type === 'deal_funding' && x.status !== 'created');
  p.innerHTML = `<h3>Payment</h3>
    <table class="lines">
      <tr><td>Agreed fee</td><td>${inr(f.agreed)}</td></tr>
      ${r.side !== 'creator' ? `<tr><td>Platform fee</td><td>${inr(f.businessFee)}</td></tr><tr><td>GST on fee</td><td>${inr(f.businessPays - f.agreed - f.businessFee)}</td></tr><tr class="total"><td>Brand pays</td><td>${inr(f.businessPays)}</td></tr>` : ''}
      ${r.side !== 'business' ? `<tr class="${r.side === 'creator' ? 'total' : ''}"><td>Creator receives</td><td>${inr(f.creatorPayout)}</td></tr>` : ''}
    </table>
    <p class="small" style="margin:10px 0 0">${pay ? `Status: ${tag(pay.status)}${pay.released_at ? ` on ${date(pay.released_at)}` : ''}` : '<span class="muted">Not paid yet</span>'}</p>`;
}

/* ---------------- Deliverables & content ---------------- */
function renderDeliverables(r) {
  const box = $('#deliverables');
  const { deal, side } = r;
  if (!r.deliverables.length) { box.innerHTML = ''; return; }
  const working = ['payment_secured', 'in_progress', 'content_submitted', 'revision_requested', 'approved'].includes(deal.status);
  box.innerHTML = `<div class="panel"><div class="panel-head"><h3>Content</h3><span class="small muted">${r.deliverables.filter((d) => d.status === 'published').length} of ${r.deliverables.length} live</span></div>
    ${r.deliverables.map((d) => {
      const subs = r.submissions.filter((s) => String(s.deliverable_id) === String(d.ROWID));
      const latest = subs[0];
      const canSubmit = side === 'creator' && working && ['pending', 'revision_requested'].includes(d.status);
      const dTag = d.status === 'submitted' ? tag('content_submitted') : d.status === 'revision_requested' ? tag('revision_requested') : tag(d.status === 'pending' ? 'pending' : d.status);
      return `<div class="deliverable">
        <div class="deliverable-head"><div><b>${esc(label(d.platform))} ${esc(label(d.content_type))} #${d.sequence_no}</b> <span class="small muted">due ${date(d.due_date)}</span></div>${dTag}</div>
        ${d.requirements ? `<div class="small muted">${esc(d.requirements)}</div>` : ''}
        ${Number(d.revision_count) ? `<div class="small">Revisions used: ${d.revision_count} of ${deal.revision_limit}</div>` : ''}
        ${latest ? submissionView(latest, side) : ''}
        ${subs.length > 1 ? `<details class="small" style="margin-top:6px"><summary>Earlier versions (${subs.length - 1})</summary>${subs.slice(1).map((s) => submissionView(s, 'history')).join('')}</details>` : ''}
        ${d.published_url ? `<p class="small" style="margin:8px 0 0">Live: <a href="${esc(d.published_url)}" target="_blank" rel="noopener">${esc(d.published_url)}</a> · ${date(d.published_at)}</p>` : ''}
        ${d.metrics && Object.keys(d.metrics).length ? `<p class="small" style="margin:4px 0 0">${['views', 'reach', 'likes', 'comments', 'shares', 'saves'].filter((k) => d.metrics[k]).map((k) => `${compact(d.metrics[k])} ${k}`).join(' · ')} <span class="muted">(${esc(label(d.metrics.source || ''))})</span></p>` : ''}
        <div class="btn-row" style="margin-top:10px">
          ${canSubmit ? `<button class="btn small" data-submit="${d.ROWID}">${d.status === 'revision_requested' ? 'Upload revised draft' : 'Upload draft'}</button>` : ''}
          ${side === 'creator' && d.status === 'approved' ? `<button class="btn small money" data-publish="${d.ROWID}">Add live link</button>` : ''}
          ${(side === 'creator' || side === 'admin') && d.status === 'published' ? `<button class="btn secondary small" data-metrics="${d.ROWID}">${d.metrics ? 'Update results' : 'Add results'}</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div>`;

  $$('[data-submit]', box).forEach((b) => { b.onclick = () => submitModal(deal.ROWID, b.dataset.submit); });
  $$('[data-publish]', box).forEach((b) => { b.onclick = () => publishModal(deal.ROWID, b.dataset.publish); });
  $$('[data-metrics]', box).forEach((b) => { b.onclick = () => metricsModal(deal.ROWID, r.deliverables.find((x) => String(x.ROWID) === b.dataset.metrics)); });
  $$('[data-approve]', box).forEach((b) => { b.onclick = busy(b, async () => { await post(`/submissions/${b.dataset.approve}/approve`); toast('Approved'); go('#/deals/' + deal.ROWID); }); });
  $$('[data-changes]', box).forEach((b) => { b.onclick = () => changesModal(deal.ROWID, b.dataset.changes); });
  $$('[data-media]', box).forEach(async (el) => {
    try {
      const url = await fileUrl(el.dataset.media);
      const isVideo = /\.(mp4|mov|webm)$/i.test(el.dataset.media);
      const isPdf = /\.pdf$/i.test(el.dataset.media);
      el.innerHTML = isVideo ? `<video src="${esc(url)}" controls preload="metadata"></video>` : isPdf ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open PDF</a>` : `<img src="${esc(url)}" alt="Draft preview">`;
    } catch { el.textContent = 'Preview unavailable'; }
  });
}

function submissionView(s, side) {
  return `<div class="submission">
    <div class="small muted" style="margin-bottom:6px">Draft ${Number(s.revision_no) + 1} · ${date(s.CREATEDTIME, true)} · ${tag(s.status === 'approved' ? 'approved' : s.status === 'changes_requested' ? 'changes_requested' : 'content_submitted')}</div>
    ${s.media_key ? `<div data-media="${esc(s.media_key)}"><span class="sk" style="width:300px;height:170px;display:block"></span></div>` : ''}
    ${s.caption ? `<div><b>Caption:</b> ${esc(s.caption)}</div>` : ''}
    ${s.hashtags ? `<div><b>Hashtags:</b> ${esc(s.hashtags)}</div>` : ''}
    ${s.mentions ? `<div><b>Mentions:</b> ${esc(s.mentions)}</div>` : ''}
    ${s.business_feedback ? `<div style="margin-top:6px;padding:8px;background:#fff;border-radius:6px"><b>Brand feedback:</b> ${esc(s.business_feedback)}</div>` : ''}
    ${side === 'business' && s.status === 'submitted' ? `<div class="btn-row" style="margin-top:10px"><button class="btn small" data-approve="${s.ROWID}">Approve</button><button class="btn secondary small" data-changes="${s.ROWID}">Request changes</button></div>` : ''}
  </div>`;
}

function submitModal(dealId, deliverableId) {
  const m = modal('Upload draft for approval', `<form id="sub">
    <label class="field"><span>Video or image</span><input type="file" name="file" accept="video/mp4,video/quicktime,video/webm,image/*"><small>Up to 50 MB for video, 10 MB for images.</small></label>
    ${field('caption', 'Caption', { type: 'textarea' })}
    <div class="grid-2">${field('hashtags', 'Hashtags')}${field('mentions', 'Mentions / tags')}</div>
    <button class="btn" type="submit">Submit for approval</button></form>`);
  const f = $('#sub', m.el);
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => {
    const d = formData(f);
    const file = f.file.files[0];
    let media_key;
    if (file) media_key = await upload(file, 'submission', dealId);
    await post(`/deliverables/${deliverableId}/submissions`, { media_key, caption: d.caption, hashtags: d.hashtags, mentions: d.mentions });
    m.close(); toast('Draft submitted'); go('#/deals/' + dealId);
  });
}

function changesModal(dealId, subId) {
  const m = modal('Request changes', `<form id="ch">${field('feedback', 'What should change?', { type: 'textarea', required: true, hint: 'Be specific, e.g. "Replace the first 3 seconds with the close-up of the watch face."' })}<button class="btn" type="submit">Send request</button></form>`);
  const f = $('#ch', m.el);
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => { const r = await post(`/submissions/${subId}/request-changes`, formData(f)); m.close(); toast(`Changes requested. ${r.revisions_left} revision(s) left.`); go('#/deals/' + dealId); });
}

function publishModal(dealId, delId) {
  const m = modal('Add the live link', `<form id="pb">${field('published_url', 'Link to the published post', { type: 'url', required: true, attrs: 'placeholder="https://www.instagram.com/reel/…"' })}<p class="small muted">Make sure the post has the paid-partnership label or #ad.</p><button class="btn" type="submit">Mark as live</button></form>`);
  const f = $('#pb', m.el);
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => { await post(`/deliverables/${delId}/publish`, formData(f)); m.close(); toast('Marked as live'); go('#/deals/' + dealId); });
}

function metricsModal(dealId, d) {
  const m0 = d.metrics || {};
  const m = modal('Post results', `<form id="mt"><p class="small muted">Copy these from your platform insights, ideally 7 days after posting.</p>
    <div class="grid-3">${['views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'clicks'].map((k) => field(k, label(k), { type: 'number', value: m0[k] || '', attrs: 'min="0"' })).join('')}</div>
    <button class="btn" type="submit">Save results</button></form>`);
  const f = $('#mt', m.el);
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => {
    const body = {};
    Object.entries(formData(f)).forEach(([k, v]) => { if (v !== '') body[k] = v; });
    await put(`/deliverables/${d.ROWID}/metrics`, body); m.close(); toast('Results saved'); go('#/deals/' + dealId);
  });
}

/* ---------------- Contract, payment, review, dispute ---------------- */
async function showContract(dealId) {
  const m = modal('Agreement', `<iframe title="Agreement" style="width:100%;height:65vh;border:1px solid var(--line);border-radius:8px" src="${BASE}/deals/${dealId}/contract"></iframe>`, { wide: true });
  return m;
}

function signModal(dealId) {
  const m = modal('Sign the agreement', `<iframe title="Agreement" style="width:100%;height:45vh;border:1px solid var(--line);border-radius:8px;margin-bottom:14px" src="${BASE}/deals/${dealId}/contract"></iframe>
    <label class="field"><input type="checkbox" id="agree"> I have read the agreement and accept its terms. I understand this counts as my electronic signature.</label>
    <button class="btn money" id="do-sign" disabled>Sign agreement</button>`, { wide: true });
  const cb = $('#agree', m.el);
  const b = $('#do-sign', m.el);
  cb.onchange = () => { b.disabled = !cb.checked; };
  b.onclick = busy(b, async () => { await post(`/deals/${dealId}/sign`, { agree: true }); m.close(); toast('Signed'); go('#/deals/' + dealId); });
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the payment window. Check your connection.'));
    document.head.appendChild(s);
  });
}

async function pay(dealId) {
  const o = await post(`/deals/${dealId}/payment-order`);
  await loadScript('https://checkout.razorpay.com/v1/checkout.js');
  await new Promise((resolve) => {
    const rzp = new window.Razorpay({
      key: o.key_id, order_id: o.order_id, amount: o.amount, currency: o.currency, name: o.name, description: o.description,
      prefill: { email: ctx.me.user.email, contact: ctx.me.business && ctx.me.business.contact_phone },
      theme: { color: '#0F6E75' },
      handler: async (resp) => {
        try { await post('/payments/verify', resp); toast('Payment secured. The creator can start.'); } catch (e) { fail(e); }
        resolve(); go('#/deals/' + dealId);
      },
      modal: { ondismiss: resolve },
    });
    rzp.on('payment.failed', (resp) => { fail(new Error((resp.error && resp.error.description) || 'Payment failed')); });
    rzp.open();
  });
}

function reviewModal(dealId, side) {
  const scores = side === 'business'
    ? [['score_quality', 'Content quality'], ['score_communication', 'Communication'], ['score_professionalism', 'Professionalism'], ['score_timeliness', 'On time']]
    : [['score_communication', 'Communication'], ['score_payment', 'Payment experience'], ['score_brief', 'Clear brief'], ['score_professionalism', 'Professionalism']];
  const vals = {};
  const m = modal(side === 'business' ? 'Review the creator' : 'Review the brand', `<form id="rv">
    ${scores.map(([k, t]) => `<div class="field"><span style="display:block;font-weight:600;font-size:13px;margin-bottom:4px">${t}</span><div class="stars" data-k="${k}" role="radiogroup" aria-label="${t}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div></div>`).join('')}
    ${field('comment', 'Comment (public)', { type: 'textarea' })}
    <button class="btn" type="submit">Post review</button></form>`);
  $$('.stars', m.el).forEach((g) => {
    $$('button', g).forEach((b) => { b.onclick = () => { vals[g.dataset.k] = Number(b.dataset.n); $$('button', g).forEach((x) => x.classList.toggle('on', Number(x.dataset.n) <= vals[g.dataset.k])); }; });
  });
  const f = $('#rv', m.el);
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => {
    if (scores.some(([k]) => !vals[k])) throw new Error('Rate every item from 1 to 5 stars');
    await post(`/deals/${dealId}/reviews`, { ...vals, comment: formData(f).comment });
    m.close(); toast('Review posted'); go('#/deals/' + dealId);
  });
}

function disputeModal(dealId) {
  const types = (ctx.meta && ctx.meta.dispute_types) || ['other'];
  const m = modal('Report a problem', `<form id="dp">
    <p class="small">Payment stays on hold while our team reviews the case. Try sorting it out in the chat first. Many issues are fixed there.</p>
    ${select('issue_type', 'What went wrong?', types, types[0])}
    ${field('description', 'Explain what happened', { type: 'textarea', required: true, hint: 'At least 20 characters. Include dates and what was agreed.' })}
    <label class="field"><span>Evidence (optional)</span><input type="file" name="files" multiple accept="image/*,application/pdf,video/*"></label>
    <button class="btn danger" type="submit">Open dispute</button></form>`);
  const f = $('#dp', m.el);
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => {
    const d = formData(f);
    const keys = [];
    for (const file of f.files.files) keys.push(await upload(file, 'evidence', dealId));
    await post(`/deals/${dealId}/disputes`, { issue_type: d.issue_type, description: d.description, evidence_keys: keys });
    m.close(); toast('Dispute opened. Our team will review it.'); go('#/deals/' + dealId);
  });
}

async function businessCard(bizId) {
  try {
    const { business: b, reviews } = await get('/businesses/' + bizId);
    modal(b.company_name, `<div style="display:flex;gap:14px;align-items:center;margin-bottom:12px">${avatar(b.company_name, b.logo_url)}<div>${b.verification_status === 'verified' ? '<span class="verified">✓ Verified business</span>' : '<span class="tag">Not verified yet</span>'}<div class="small muted">${esc(b.category || '')} ${b.city ? '· ' + esc(b.city) : ''}</div></div></div>
      ${b.website ? `<p><a href="${esc(b.website)}" target="_blank" rel="noopener">${esc(b.website)}</a></p>` : ''}${b.about ? `<p>${esc(b.about)}</p>` : ''}
      <h3>Reviews from creators</h3>${reviews.length ? reviews.map((r) => `<p class="small"><b>${Number(r.overall).toFixed(1)}★</b> ${esc(r.comment || '')}</p>`).join('') : '<p class="small muted">No reviews yet.</p>'}`);
  } catch (e) { fail(e); }
}

/* ---------------- Chat ---------------- */
function initChat(dealId, side) {
  const box = $('#chat');
  let lastId = null;
  box.innerHTML = `<div class="chat-log" id="log"><div class="msg system"><span class="sk" style="width:160px;height:12px"></span></div></div>
    ${side === 'admin' ? '' : `<form class="chat-form" id="cf"><label class="btn secondary small" style="cursor:pointer" title="Attach file">+<input type="file" hidden id="att"></label><textarea name="body" placeholder="Write a message" aria-label="Message"></textarea><button class="btn" type="submit">Send</button></form>`}`;
  const log = $('#log');
  const render = (msgs, append) => {
    if (!append) log.innerHTML = '';
    if (!append && !msgs.length) log.innerHTML = '<div class="msg system">No messages yet. Say hello and discuss the details here. Everything stays with the deal.</div>';
    msgs.forEach((m) => {
      const el = document.createElement('div');
      el.className = 'msg' + (m.mine ? ' mine' : '') + (append ? ' arrive' : '');
      el.innerHTML = `${m.body ? esc(m.body) : ''}${m.attachment_key ? `<div><a href="#" data-att="${esc(m.attachment_key)}" style="color:inherit">📎 Attachment</a></div>` : ''}<span class="meta">${m.mine ? 'You' : esc(label(m.sender_role))} · ${date(m.CREATEDTIME, true)}</span>`;
      log.appendChild(el);
      lastId = m.ROWID;
    });
    $$('[data-att]', log).forEach((a) => { a.onclick = async (e) => { e.preventDefault(); try { window.open(await fileUrl(a.dataset.att), '_blank', 'noopener'); } catch (err) { fail(err); } }; });
    log.scrollTop = log.scrollHeight;
  };
  const load = async (append) => {
    try {
      const { data } = await get(`/deals/${dealId}/messages` + (append && lastId ? `?after=${lastId}` : ''));
      if (!append || data.length) render(data, append && log.querySelector('.msg:not(.system)'));
    } catch { /* keep quiet on poll errors */ }
  };
  load(false);
  chatTimer = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 10000);
  const f = $('#cf');
  if (!f) return;
  const send = async (payload) => { await post(`/deals/${dealId}/messages`, payload); await load(true); };
  f.onsubmit = (e) => { e.preventDefault(); go2(); };
  const go2 = busy($('button[type=submit]', f), async () => { const body = f.body.value.trim(); if (!body) return; await send({ body }); f.body.value = ''; });
  f.body.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); } };
  $('#att').onchange = async (e) => { const file = e.target.files[0]; if (!file) return; try { const key = await upload(file, 'attachment', dealId); await send({ attachment_key: key, body: file.name }); } catch (err) { fail(err); } };
}

/* ---------------- Offer builder (new offer + counter) ---------------- */
export function openOfferModal({ title, initial, counter, campaigns = [], rates = [], onSubmit }) {
  const t = initial || { deliverables: [{ platform: 'instagram', content_type: 'reel', quantity: 1 }], price_breakdown: [], usage_rights_days: 0, exclusivity_days: 0 };
  const platforms = ['instagram', 'youtube', 'facebook', 'x', 'linkedin', 'other'];
  const contentTypes = ['reel', 'story', 'static_post', 'carousel', 'short', 'dedicated_video', 'integrated_mention', 'live', 'review'];
  const minDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const m = modal(title, `<form id="of">
    ${!counter && campaigns.length ? select('campaign_id', 'Campaign', campaigns.map((c) => [c.ROWID, c.name]), '', { blank: 'No campaign' }) : ''}
    <h3>Deliverables</h3><div id="dl"></div><button type="button" class="btn ghost small" id="add-dl">Add deliverable</button>
    ${rates.length ? `<div class="small" style="margin:8px 0">From rate card: ${rates.filter((r) => r.rate_kind === 'content').slice(0, 8).map((r, i) => `<button type="button" class="chip" data-rate="${i}">${esc(label(r.service_type))} ${inr(r.price)}</button>`).join(' ')}</div>` : ''}
    <h3 style="margin-top:14px">Price</h3><div id="pl"></div><button type="button" class="btn ghost small" id="add-pl">Add price line</button>
    <table class="lines" style="margin:10px 0 16px"><tr class="total"><td>Total</td><td id="tot">₹0</td></tr></table>
    <div class="grid-3">${field('deadline', 'Deadline', { type: 'date', value: t.deadline || '', attrs: `min="${minDate}"` })}${field('usage_rights_days', 'Usage rights (days)', { type: 'number', value: t.usage_rights_days || 0, attrs: 'min="0"' })}${field('exclusivity_days', 'Exclusivity (days)', { type: 'number', value: t.exclusivity_days || 0, attrs: 'min="0"' })}</div>
    <div class="grid-2">${field('revision_limit', 'Revisions per piece', { type: 'number', value: t.revision_limit ?? 2, attrs: 'min="0" max="10"' })}<label class="field" style="padding-top:26px"><input type="checkbox" name="requires_shipping" data-bool ${t.requires_shipping ? 'checked' : ''}> Product will be shipped</label></div>
    ${field('brief', 'Brief', { type: 'textarea', value: t.brief || '', hint: 'Key message, must-haves, hashtags, @mentions, things to avoid.' })}
    ${field('message', counter ? 'Note about your changes' : 'Message to the creator', { type: 'textarea' })}
    <button class="btn money" type="submit">${counter ? 'Send counter offer' : 'Send offer'}</button></form>`, { wide: true });

  const dl = $('#dl', m.el);
  const pl = $('#pl', m.el);
  const addDl = (d = {}) => {
    const row = document.createElement('div');
    row.className = 'grid-4';
    row.style.cssText = 'grid-template-columns:1fr 1fr 70px 2fr auto;gap:0 8px;align-items:end';
    row.innerHTML = `${select('d_platform', 'Platform', platforms, d.platform || 'instagram')}${select('d_type', 'Content', contentTypes, d.content_type || 'reel')}${field('d_qty', 'Qty', { type: 'number', value: d.quantity || 1, attrs: 'min="1" max="20"' })}${field('d_req', 'Requirements', { value: d.requirements || '' })}<button type="button" class="btn ghost small" style="margin-bottom:14px" aria-label="Remove">✕</button>`;
    $('button', row).onclick = () => row.remove();
    dl.appendChild(row);
  };
  const addPl = (p = {}) => {
    const row = document.createElement('div');
    row.className = 'grid-3';
    row.style.cssText = 'grid-template-columns:2fr 1fr auto;gap:0 8px;align-items:end';
    row.innerHTML = `${field('p_label', 'Item', { value: p.label || '', attrs: 'placeholder="e.g. 2 Reels, usage rights"' })}${field('p_amount', 'Amount (₹)', { type: 'number', value: p.amount ?? '', attrs: 'min="0" step="1"' })}<button type="button" class="btn ghost small" style="margin-bottom:14px" aria-label="Remove">✕</button>`;
    $('button', row).onclick = () => { row.remove(); total(); };
    $('input[name=p_amount]', row).oninput = total;
    pl.appendChild(row);
  };
  const total = () => {
    const s = $$('input[name=p_amount]', pl).reduce((a, i) => a + (Number(i.value) || 0), 0);
    const t = $('#tot', m.el);
    if (t.textContent !== inr(s)) { t.textContent = inr(s); t.classList.remove('bump'); void t.offsetWidth; t.classList.add('bump'); }
    return s;
  };
  (t.deliverables || []).forEach(addDl);
  (t.price_breakdown && t.price_breakdown.length ? t.price_breakdown : [{ label: 'Content fee', amount: t.total_amount || '' }]).forEach(addPl);
  total();
  $('#add-dl', m.el).onclick = () => addDl();
  $('#add-pl', m.el).onclick = () => { addPl(); total(); };
  let pristine = !initial;
  $$('[data-rate]', m.el).forEach((b) => { b.onclick = () => { if (pristine) { dl.innerHTML = ''; pl.innerHTML = ''; pristine = false; } const r = rates.filter((x) => x.rate_kind === 'content')[Number(b.dataset.rate)]; addDl({ platform: r.platform === 'any' ? 'instagram' : r.platform, content_type: r.service_type, quantity: 1 }); addPl({ label: label(r.service_type), amount: r.price }); total(); }; });

  const f = $('#of', m.el);
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => {
    const deliverables = $$('.grid-4', dl).map((row) => ({ platform: $('[name=d_platform]', row).value, content_type: $('[name=d_type]', row).value, quantity: Number($('[name=d_qty]', row).value) || 1, requirements: $('[name=d_req]', row).value.trim() || undefined }));
    const price_breakdown = $$('.grid-3', pl).map((row) => ({ label: $('[name=p_label]', row).value.trim() || 'Fee', amount: Number($('[name=p_amount]', row).value) || 0 })).filter((x) => x.amount > 0);
    if (!deliverables.length) throw new Error('Add at least one deliverable');
    if (!price_breakdown.length) throw new Error('Add a price');
    const d = formData(f);
    const body = { deliverables, price_breakdown, total_amount: total(), deadline: d.deadline || undefined, usage_rights_days: Number(d.usage_rights_days) || 0,
      exclusivity_days: Number(d.exclusivity_days) || 0, revision_limit: Number(d.revision_limit), requires_shipping: d.requires_shipping, brief: d.brief, message: d.message };
    if (d.campaign_id) body.campaign_id = d.campaign_id;
    await onSubmit(body);
    m.close();
  });
}
