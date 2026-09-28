import { get, post, qs, fileUrl } from '../api.js';
import { $, $$, esc, inr, compact, label, date, tag, toast, fail, modal, confirmBox, formData, busy, field, select, emptyState, isTrue } from '../ui.js';
import { go } from '../state.js';

const main = () => $('#main');

export async function overview() {
  const s = await get('/admin/stats');
  main().innerHTML = `
    <div class="page-head"><div><h1>Platform overview</h1><p>Money moving through Brandfluence and what needs attention.</p></div></div>
    <div class="figures">
      <div class="figure"><b>${compact(s.users.creators)}</b><span>Creators</span></div>
      <div class="figure"><b>${compact(s.users.businesses)}</b><span>Businesses</span></div>
      <div class="figure"><b>${s.deals.active}</b><span>Active deals</span></div>
      <div class="figure"><b>${s.deals.completed}</b><span>Completed deals</span></div>
    </div>
    <div class="figures">
      <div class="figure money"><b>${inr(s.gmv)}</b><span>Money through the platform</span></div>
      <div class="figure money"><b>${inr(s.platform_revenue)}</b><span>Platform revenue</span></div>
      <div class="figure"><b>${inr(s.funds_held)}</b><span>Currently held</span></div>
    </div>
    <h2>Needs attention</h2>
    <div class="rows">
      <a class="row" href="#/admin/disputes"><div><div class="t">Open disputes</div><div class="s">Payment frozen until resolved</div></div><span class="tag ${s.open_disputes ? 'rose' : ''}">${s.open_disputes}</span></a>
      <a class="row" href="#/admin/businesses"><div><div class="t">Businesses waiting for verification</div><div class="s">Documents submitted</div></div><span class="tag ${s.pending_verifications.businesses ? 'gold' : ''}">${s.pending_verifications.businesses}</span></a>
      <a class="row" href="#/admin/creators"><div><div class="t">Creator payout accounts to check</div><div class="s">Razorpay account IDs submitted</div></div><span class="tag ${s.pending_verifications.creator_payouts ? 'gold' : ''}">${s.pending_verifications.creator_payouts}</span></a>
    </div>`;
}

const TITLES = { disputes: 'Disputes', creators: 'Creators', businesses: 'Businesses', users: 'Users', deals: 'Deals', payments: 'Payments', audit: 'Audit log' };
const FILTERS = {
  disputes: ['status', [['open,under_review', 'Open'], ['resolved', 'Resolved'], ['', 'All']]],
  creators: ['kyc_status', [['', 'All'], ['submitted', 'Payout account to check'], ['verified', 'Payouts verified']]],
  businesses: ['verification_status', [['submitted', 'Waiting'], ['', 'All'], ['verified', 'Verified'], ['rejected', 'Rejected']]],
  users: ['role', [['', 'All'], ['creator', 'Creators'], ['business', 'Businesses'], ['admin', 'Admins']]],
  deals: ['status', [['', 'All'], ['disputed', 'Disputed'], ['payment_secured,in_progress,content_submitted,revision_requested,approved,published', 'In progress'], ['completed', 'Completed']]],
  payments: ['status', [['', 'All'], ['held', 'Held'], ['released', 'Released'], ['refunded', 'Refunded']]],
  audit: [null, []],
};

export async function list(kind, state = {}) {
  const [key, opts] = FILTERS[kind];
  const val = state.f !== undefined ? state.f : (opts[0] ? opts[0][0] : '');
  const params = { size: 100, q: state.q };
  if (key && val) params[key] = val;
  const { data } = await get(`/admin/${kind}` + qs(params));
  main().innerHTML = `
    <div class="page-head"><div><h1>${TITLES[kind]}</h1></div>
      ${['creators', 'businesses', 'users', 'deals'].includes(kind) ? `<form id="sq" class="btn-row"><input name="q" value="${esc(state.q || '')}" placeholder="Search" style="width:220px"><button class="btn secondary">Search</button></form>` : ''}</div>
    ${opts.length ? `<nav class="tabs">${opts.map(([v, t]) => `<a href="#" data-f="${v}" class="${v === val ? 'active' : ''}">${t}</a>`).join('')}</nav>` : ''}
    ${data.length ? `<div class="table-wrap">${TABLES[kind](data)}</div>` : `<div class="rows">${emptyState('Nothing here.')}</div>`}`;
  $$('[data-f]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); list(kind, { ...state, f: a.dataset.f }); }; });
  const sq = $('#sq');
  if (sq) sq.onsubmit = (e) => { e.preventDefault(); list(kind, { ...state, q: formData(sq).q }); };
  bind(kind, data, () => list(kind, state));
}

const TABLES = {
  disputes: (rows) => `<table class="data"><thead><tr><th>#</th><th>Raised</th><th>By</th><th>Issue</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((d) => `<tr><td>${d.ROWID.toString().slice(-6)}</td><td>${date(d.CREATEDTIME)}</td><td>${esc(label(d.raised_by_role))}</td><td>${esc(label(d.issue_type))}</td><td>${inr(d.amount_in_dispute)}</td><td>${tag(d.status)}</td><td><a class="btn small" href="#/admin/disputes/${d.ROWID}">Open case</a></td></tr>`).join('')}</tbody></table>`,
  creators: (rows) => `<table class="data"><thead><tr><th>Creator</th><th>Audience</th><th>Profile</th><th>Verified</th><th>Payouts</th><th></th></tr></thead><tbody>
    ${rows.map((c) => `<tr><td><b>${esc(c.full_name)}</b><div class="small muted">@${esc(c.username)} · ${esc(c.city || '')}</div></td><td>${compact(c.total_followers)}</td><td>${c.profile_strength}%</td><td>${isTrue(c.is_verified) ? '<span class="verified">✓</span>' : '—'}</td><td>${c.has_payout_account ? tag(c.kyc_status) : '<span class="muted small">Not set</span>'}</td>
    <td class="nowrap"><a class="btn ghost small" href="#/creators/${c.ROWID}">View</a><button class="btn secondary small" data-verify-c="${c.ROWID}">Review</button></td></tr>`).join('')}</tbody></table>`,
  businesses: (rows) => `<table class="data"><thead><tr><th>Business</th><th>GSTIN</th><th>Documents</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((b) => { let docs = []; try { docs = JSON.parse(b.verification_docs || '[]'); } catch { /* none */ } return `<tr><td><b>${esc(b.company_name)}</b><div class="small muted">${esc(b.category || '')} · ${esc(b.city || '')} · ${esc(b.contact_email || '')}</div></td><td>${esc(b.gstin || '—')}</td>
    <td>${docs.map((k, i) => `<a href="#" class="small" data-doc="${esc(k)}">Document ${i + 1}</a>`).join('<br>') || '<span class="muted small">None</span>'}</td><td>${tag(b.verification_status || 'pending')}</td>
    <td class="nowrap"><button class="btn small" data-verify-b="${b.ROWID}" data-s="verified">Verify</button><button class="btn ghost small" data-verify-b="${b.ROWID}" data-s="rejected">Reject</button></td></tr>`; }).join('')}</tbody></table>`,
  users: (rows) => `<table class="data"><thead><tr><th>Email</th><th>Role</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((u) => `<tr><td>${esc(u.email || '—')}<div class="small muted">${esc(u.phone || '')}</div></td><td>${esc(label(u.role))}</td><td>${date(u.CREATEDTIME)}</td><td>${tag(u.status || 'active')}</td>
    <td>${u.role === 'admin' ? '' : `<button class="btn ghost small" data-user="${u.ROWID}" data-s="${u.status === 'suspended' ? 'active' : 'suspended'}">${u.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button>`}</td></tr>`).join('')}</tbody></table>`,
  deals: (rows) => `<table class="data"><thead><tr><th>Deal</th><th>Amount</th><th>Fee</th><th>Status</th><th>Updated</th></tr></thead><tbody>
    ${rows.map((d) => `<tr><td><a href="#/deals/${d.ROWID}">${esc(d.deal_number)}</a></td><td>${inr(d.agreed_amount)}</td><td>${inr(d.platform_fee)}</td><td>${tag(d.status)}</td><td>${date(d.MODIFIEDTIME)}</td></tr>`).join('')}</tbody></table>`,
  payments: (rows) => `<table class="data"><thead><tr><th>Date</th><th>Deal</th><th>Gross</th><th>Fee</th><th>GST</th><th>To creator</th><th>Razorpay</th><th>Status</th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td>${date(p.CREATEDTIME)}</td><td><a href="#/deals/${p.deal_id}">Open</a></td><td>${inr(p.gross_amount)}</td><td>${inr(p.platform_fee)}</td><td>${inr(p.tax_amount)}</td><td>${inr(p.net_amount)}</td><td class="small">${esc(p.gateway_payment_id || p.gateway_order_id || '—')}</td><td>${tag(p.status)}</td></tr>`).join('')}</tbody></table>`,
  audit: (rows) => `<table class="data"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Change</th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td class="nowrap">${date(a.CREATEDTIME, true)}</td><td>${esc(label(a.actor_role || 'system'))}</td><td>${esc(label(a.action))}</td><td>${a.entity_type === 'deal' ? `<a href="#/deals/${a.entity_id}">Deal</a>` : esc(label(a.entity_type))}</td><td class="small">${a.from_status ? `${esc(label(a.from_status))} → ${esc(label(a.to_status))}` : ''}</td></tr>`).join('')}</tbody></table>`,
};

function bind(kind, data, refresh) {
  $$('[data-doc]').forEach((a) => { a.onclick = async (e) => { e.preventDefault(); try { window.open(await fileUrl(a.dataset.doc), '_blank', 'noopener'); } catch (err) { fail(err); } }; });
  $$('[data-verify-b]').forEach((b) => { b.onclick = busy(b, async () => {
    const s = b.dataset.s;
    const note = s === 'rejected' ? prompt('Reason for rejecting (sent to the business):') : '';
    if (s === 'rejected' && !note) return;
    await post(`/admin/businesses/${b.dataset.verifyB}/verify`, { status: s, note });
    toast(s === 'verified' ? 'Business verified' : 'Business rejected'); refresh();
  }); });
  $$('[data-user]').forEach((b) => { b.onclick = async () => {
    const s = b.dataset.s;
    if (!(await confirmBox(s === 'suspended' ? 'Suspend this user?' : 'Reactivate this user?', s === 'suspended' ? 'They will be signed out of all actions until reactivated.' : 'They will regain access.', s === 'suspended' ? 'Suspend' : 'Reactivate', s === 'suspended'))) return;
    try { await post(`/admin/users/${b.dataset.user}/status`, { status: s }); refresh(); } catch (e) { fail(e); }
  }; });
  $$('[data-verify-c]').forEach((b) => { b.onclick = () => {
    const c = data.find((x) => String(x.ROWID) === b.dataset.verifyC);
    const m = modal(`Review ${c.full_name}`, `<form id="vc">
      <label class="field"><input type="checkbox" name="is_verified" data-bool ${isTrue(c.is_verified) ? 'checked' : ''}> Show verified badge (identity and accounts checked)</label>
      ${c.has_payout_account ? select('kyc_status', 'Payout account (check the acc_ ID is active and KYC-approved in the Razorpay dashboard)', ['submitted', 'verified', 'rejected'], c.kyc_status) : '<p class="small muted">No payout account submitted yet.</p>'}
      ${field('note', 'Note to the creator (optional)')}
      <button class="btn" type="submit">Save</button></form>`);
    const f = $('#vc', m.el);
    f.onsubmit = async (e) => { e.preventDefault(); try { const d = formData(f); if (d.kyc_status === 'submitted') delete d.kyc_status; await post(`/admin/creators/${c.ROWID}/verify`, d); m.close(); toast('Saved'); refresh(); } catch (err) { fail(err); } };
  }; });
}

/* ---------------- Dispute case file ---------------- */
export async function disputePage(id) {
  const r = await get('/admin/disputes/' + id);
  const d = r.dispute;
  const ev = (() => { try { return JSON.parse(d.evidence_json || '{}'); } catch { return {}; } })();
  const pay = r.payments.find((p) => p.payment_type === 'deal_funding');
  const open = ['open', 'under_review'].includes(d.status);
  main().innerHTML = `
    <div class="page-head"><div><div class="muted small"><a href="#/admin/disputes">Disputes</a> / ${esc(r.deal.deal_number)}</div><h1>${esc(label(d.issue_type))}</h1>
      <p>${tag(d.status)} Raised by the ${esc(d.raised_by_role === 'business' ? 'brand' : 'creator')} on ${date(d.CREATEDTIME, true)}</p></div>
      <div class="btn-row"><a class="btn secondary" href="#/deals/${r.deal.ROWID}">Open deal</a>${d.status === 'open' ? '<button class="btn secondary" id="take">Mark under review</button>' : ''}</div></div>
    <div class="cols">
      <div>
        <div class="panel"><h3>Complaint</h3><p style="white-space:pre-wrap">${esc(d.description)}</p>
          ${(ev.files || []).length ? `<p class="small">Evidence: ${ev.files.map((k, i) => `<a href="#" data-file="${esc(k)}">File ${i + 1}</a>`).join(', ')}</p>` : ''}
          <p class="small muted">Deal was at “${esc(label(ev.prev_status || ''))}” when this was raised.</p></div>
        <div class="panel"><h3>Content submitted</h3>${r.deliverables.map((x) => `<div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)"><b>${esc(label(x.platform))} ${esc(label(x.content_type))} #${x.sequence_no}</b> — ${esc(label(x.status))}, due ${date(x.due_date)}${x.published_url ? ` · <a href="${esc(x.published_url)}" target="_blank" rel="noopener">live post</a>` : ''}
          ${r.submissions.filter((s) => String(s.deliverable_id) === String(x.ROWID)).map((s) => `<div style="margin-left:12px">Draft ${Number(s.revision_no) + 1} on ${date(s.CREATEDTIME, true)}: ${esc(label(s.status))}${s.media_key ? ` · <a href="#" data-file="${esc(s.media_key)}">view file</a>` : ''}${s.business_feedback ? ` · feedback: “${esc(s.business_feedback)}”` : ''}</div>`).join('')}</div>`).join('') || '<p class="muted small">No deliverables.</p>'}</div>
        <div class="panel"><h3>Chat (${r.messages.length})</h3><div style="max-height:360px;overflow-y:auto">${r.messages.map((m) => `<div class="small" style="padding:4px 0"><span class="muted">${date(m.CREATEDTIME, true)}</span> <b>${esc(label(m.sender_role))}:</b> ${esc(m.body || '')}${m.attachment_key ? ` <a href="#" data-file="${esc(m.attachment_key)}">attachment</a>` : ''}</div>`).join('') || '<p class="muted small">No messages.</p>'}</div></div>
        <div class="panel"><h3>Timeline</h3>${r.timeline.map((t) => `<div class="small" style="padding:3px 0"><span class="muted">${date(t.CREATEDTIME, true)}</span> ${esc(label(t.actor_role || 'system'))}: ${esc(label(t.action))} ${t.to_status ? '→ ' + esc(label(t.to_status)) : ''}</div>`).join('')}</div>
      </div>
      <div>
        <div class="panel"><h3>Parties</h3><p class="small"><b>Brand:</b> ${esc(r.business.company_name)}<br>${esc(r.business.contact_email || '')}</p><p class="small"><b>Creator:</b> ${esc(r.creator.full_name)} (@${esc(r.creator.username)})</p>
          <p class="small"><b>Agreement:</b> brand signed ${date(r.deal.business_signed_at, true)}, creator signed ${date(r.deal.creator_signed_at, true)}. Revisions allowed: ${r.deal.revision_limit}. Deadline ${date(r.deal.deadline)}.</p></div>
        <div class="panel"><h3>Money</h3><table class="lines"><tr><td>Brand paid</td><td>${inr(pay && pay.gross_amount)}</td></tr><tr><td>Held for creator</td><td>${inr(pay && pay.net_amount)}</td></tr><tr class="total"><td>Status</td><td>${pay ? esc(label(pay.status)) : 'No payment'}</td></tr></table></div>
        ${open ? `<form class="panel" id="rs"><h3>Decision</h3>
          ${select('resolution', 'Outcome', [['release', 'Pay the creator in full'], ['partial', 'Split: refund part to the brand'], ['refund', 'Refund the brand in full'], ['dismiss', 'No money change, continue the deal']], 'release')}
          <div id="amt" class="hidden">${field('refund_amount', 'Refund to brand (₹)', { type: 'number', attrs: `min="1" max="${pay ? pay.net_amount : 0}"` })}</div>
          ${field('notes', 'Reason (shared with both parties)', { type: 'textarea', required: true })}
          <button class="btn danger" type="submit">Apply decision</button></form>` : `<div class="panel"><h3>Decision</h3><p><b>${esc(label(d.resolution))}</b>${d.refund_amount ? ` — ${inr(d.refund_amount)} refunded` : ''}</p><p class="small">${esc(d.resolution_notes || '')}</p><p class="small muted">${date(d.resolved_at, true)}</p></div>`}
      </div>
    </div>`;
  $$('[data-file]').forEach((a) => { a.onclick = async (e) => { e.preventDefault(); try { window.open(await fileUrl(a.dataset.file), '_blank', 'noopener'); } catch (err) { fail(err); } }; });
  const take = $('#take');
  if (take) take.onclick = busy(take, async () => { await post(`/admin/disputes/${id}/review`); go('#/admin/disputes/' + id); });
  const f = $('#rs');
  if (!f) return;
  f.resolution.onchange = () => $('#amt').classList.toggle('hidden', f.resolution.value !== 'partial');
  f.onsubmit = (e) => { e.preventDefault(); apply(); };
  const apply = busy($('button[type=submit]', f), async () => {
    const d2 = formData(f);
    if (!(await confirmBox('Apply this decision?', 'Money movements through Razorpay cannot be undone.', 'Apply decision', true))) return;
    await post(`/admin/disputes/${id}/resolve`, d2);
    toast('Decision applied'); go('#/admin/disputes/' + id);
  });
}
