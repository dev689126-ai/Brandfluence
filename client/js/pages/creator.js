import { get, post, put, del, upload } from '../api.js';
import { $, $$, esc, inr, compact, pct, label, date, tag, toast, fail, modal, confirmBox, formData, busy, field, select, chips, emptyState, avatar, isTrue } from '../ui.js';
import { ctx, go } from '../state.js';
import { dealRows } from './deals.js';
import { platformMark } from '../icons.js';

const main = () => $('#main');
const PLATFORMS = ['instagram', 'youtube', 'twitch', 'facebook', 'x', 'linkedin', 'other'];

/* ---------------- Home ---------------- */
export async function home() {
  const [d, deals] = await Promise.all([get('/creators/me/dashboard'), get('/deals?size=8')]);
  const pending = deals.data.filter((x) => ['offer_sent', 'negotiation'].includes(x.status));
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  main().innerHTML = `
    <div class="page-head"><div><h1>${greet}, ${esc(d.name.split(' ')[0])}</h1><p>Here's where your brand work stands.</p></div>
      <a class="btn secondary" href="#/profile">Edit profile</a></div>
    <div class="figures">
      <div class="figure"><b>${compact(d.audience)}</b><span>Total audience</span></div>
      <div class="figure"><b>${pct(d.avg_engagement)}</b><span>Avg. engagement</span></div>
      <div class="figure"><b>${d.active_deals}</b><span>Active deals</span></div>
      <div class="figure money"><b>${inr(d.earnings.released)}</b><span>Earned</span></div>
      <div class="figure"><b>${inr(d.earnings.pending)}</b><span>Held for you</span></div>
    </div>
    <div class="cols">
      <div>
        ${pending.length ? `<div class="next-step"><h3>${pending.length === 1 ? 'An offer is waiting for you' : `${pending.length} offers are waiting for you`}</h3><p>Accept, reply with your price, or decline.</p><a class="btn money" href="#/deals/${pending[0].ROWID}">Review offer</a></div>` : ''}
        <div class="panel-head"><h2>Recent deals</h2><a class="btn ghost small" href="#/deals">All deals</a></div>
        ${deals.data.length ? dealRows(deals.data) : `<div class="rows">${emptyState('No deals yet. A complete profile with connected accounts and a rate card is what brands look for.', '<a class="btn" href="#/profile/social">Connect an account</a>')}</div>`}
      </div>
      <div>
        <div class="panel">
          <h3>Profile strength</h3>
          <div class="strength"><i style="width:${d.profile_strength}%"></i></div>
          <p class="small muted">${d.profile_strength}% complete. ${d.profile_strength < 100 ? 'Profiles above 80% show up higher in brand searches.' : 'Your profile is complete.'}</p>
          <a class="btn secondary small" href="#/profile">Improve profile</a>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Accounts</h3><a class="btn ghost small" href="#/profile/social">Manage</a></div>
          ${d.social.length ? d.social.map((a) => `<div class="row" style="padding:8px 0"><div style="display:flex;gap:10px;align-items:center">${platformMark(a.platform)}<div><div class="t">${esc(label(a.platform))}</div><div class="s">@${esc(a.handle)} ${a.verified ? '<span class="verified">✓ verified</span>' : '<span class="muted">self-reported</span>'}</div></div></div><b>${compact(a.followers)}</b></div>`).join('') : '<p class="muted small">No accounts connected yet.</p>'}
        </div>
      </div>
    </div>`;
}

/* ---------------- Profile (tabs) ---------------- */
const TABS = [['details', 'Details'], ['social', 'Social accounts'], ['rates', 'Rate card'], ['portfolio', 'Portfolio'], ['availability', 'Availability'], ['payout', 'Payout account']];

export async function profile(tab) {
  const p = await get('/creators/me');
  main().innerHTML = `
    <div class="page-head"><div><h1>My profile</h1><p>This is what brands see when they find you.</p></div>
      <button class="btn secondary" id="preview">Preview as brand</button></div>
    <nav class="tabs">${TABS.map(([k, t]) => `<a href="#/profile/${k}" class="${k === tab ? 'active' : ''}">${t}</a>`).join('')}</nav>
    <div id="tab"></div>`;
  $('#preview').onclick = (e) => { e.preventDefault(); previewModal(p); };
  const fn = { details, social, rates, portfolio, availability, payout }[tab] || details;
  await fn(p);
}

async function details(p) {
  const c = p.creator;
  let cats = [];
  let types = [];
  try { [cats, types] = await Promise.all([get('/meta/categories?group=creator').then((r) => r.data), get('/meta/categories?group=creator_type').then((r) => r.data)]); } catch { /* optional */ }
  $('#tab').innerHTML = `
    <form class="panel" id="f">
      <div style="display:flex;gap:18px;align-items:center;margin-bottom:18px">
        ${avatar(c.full_name, c.photo_url, 'lg')}
        <div><label class="btn secondary small" style="cursor:pointer">Change photo<input type="file" accept="image/jpeg,image/png,image/webp" id="photo" hidden></label>
        <p class="small muted" style="margin:6px 0 0">Square image, at least 400×400.</p></div>
      </div>
      <div class="grid-2">${field('full_name', 'Full name', { value: c.full_name, required: true })}${field('username', 'Username', { value: c.username, required: true })}</div>
      ${field('bio', 'Bio', { type: 'textarea', value: c.bio })}
      <div class="grid-3">${field('city', 'City', { value: c.city })}${field('state', 'State', { value: c.state })}${field('country', 'Country', { value: c.country })}</div>
      <div class="grid-2">${select('gender', 'Gender (optional)', ['female', 'male', 'non_binary', 'prefer_not_to_say'], c.gender, { blank: '—' })}${select('age_range', 'Age range (optional)', ['18-24', '25-34', '35-44', '45+'], c.age_range, { blank: '—' })}</div>
      <label class="field"><span>Categories</span>${chips('categories', cats.map((x) => x.name), c.categories)}</label>
      <label class="field"><span>Creator type</span>${chips('creator_types', types.map((x) => x.name), c.creator_types)}</label>
      <label class="field"><span>Languages</span>${chips('languages', ['Hindi', 'English', 'Gujarati', 'Marathi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Bengali', 'Punjabi', 'Odia'], c.languages)}</label>
      <label class="field"><input type="checkbox" name="is_available" data-bool ${isTrue(c.is_available) ? 'checked' : ''}> Open to new collaborations</label>
      <button class="btn" type="submit">Save changes</button>
    </form>`;
  const f = $('#f');
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => {
    const d = formData(f);
    ['categories', 'creator_types', 'languages'].forEach((k) => { d[k] = d[k] || []; });
    await put('/creators/me', d);
    toast('Profile saved');
  });
  $('#photo').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try { const key = await upload(file, 'avatar'); await put('/creators/me', { photo_url: key }); toast('Photo updated'); go('#/profile/details'); } catch (err) { fail(err); }
  };
}

async function social(p) {
  $('#tab').innerHTML = `
    <div class="panel">
      <div class="panel-head"><div><h2>Social accounts</h2><p class="small muted" style="margin:0">YouTube and Instagram numbers are checked with the platform and marked verified. Others show as self-reported until official connections are added.</p></div>
      <button class="btn" id="add">Add account</button></div>
      ${p.social.length ? `<div class="table-wrap" style="border:0"><table class="data"><thead><tr><th>Platform</th><th>Handle</th><th>Followers</th><th>Avg. views</th><th>Engagement</th><th>Status</th><th></th></tr></thead><tbody>
      ${p.social.map((a) => `<tr><td>${platformMark(a.platform)} ${esc(label(a.platform))}</td><td>@${esc(a.handle)}</td><td>${compact(a.followers)}</td><td>${compact(a.avg_views)}</td><td>${pct(a.engagement_rate)}</td>
        <td>${a.verified ? `<span class="verified">✓ Verified</span><div class="small muted">${date(a.last_synced_at)}</div>` : '<span class="tag">Self-reported</span>'}</td>
        <td class="nowrap"><button class="btn ghost small" data-sync="${a.ROWID}">Refresh</button><button class="btn ghost small" data-rm="${a.ROWID}">Remove</button></td></tr>`).join('')}</tbody></table></div>`
      : emptyState('Add your main accounts so brands can see your reach.')}
    </div>`;
  $('#add').onclick = () => {
    const auto = (ctx.meta && ctx.meta.auto_sync) || [];
    const m = modal('Add a social account', `<form id="sf">
      ${select('platform', 'Platform', PLATFORMS, 'instagram')}
      ${field('handle', 'Handle or profile link', { required: true, attrs: 'placeholder="@yourname or https://…"' })}
      <p class="small" id="sync-note"></p>
      <div id="manual"><div class="grid-3">${field('followers', 'Followers', { type: 'number', attrs: 'min="0"' })}${field('avg_views', 'Avg. views', { type: 'number', attrs: 'min="0"' })}${field('engagement_rate', 'Engagement %', { type: 'number', attrs: 'min="0" max="100" step="0.1"' })}</div></div>
      <button class="btn" type="submit">Add account</button></form>`);
    const f = $('#sf', m.el);
    const refresh = () => {
      const p = f.platform.value;
      const isAuto = auto.includes(p);
      $('#manual', m.el).classList.toggle('hidden', isAuto);
      $('#sync-note', m.el).innerHTML = isAuto
        ? `<span class="verified">✓ Automatic</span> We'll fetch your ${esc(label(p))} numbers from ${esc(label(p))} and keep them updated every night.`
        : `<span class="muted">${esc(label(p))} numbers can't be checked automatically yet, so add them yourself. They'll show as self-reported.</span>`;
    };
    f.platform.onchange = refresh;
    refresh();
    f.onsubmit = (e) => { e.preventDefault(); go2(); };
    const go2 = busy($('button[type=submit]', f), async () => {
      const d = formData(f);
      if (auto.includes(d.platform)) { delete d.followers; delete d.avg_views; delete d.engagement_rate; }
      const r = await post('/creators/me/social', d);
      m.close();
      toast(r.verified ? `Connected. ${compact(r.account.followers)} followers found.` : auto.includes(d.platform) ? 'Added, but we couldn\'t find that account. Check the handle.' : 'Account added (self-reported)');
      go('#/profile/social');
    });
  };
  $$('[data-sync]').forEach((b) => { b.onclick = busy(b, async () => { const r = await post(`/creators/me/social/${b.dataset.sync}/sync`); toast(r.verified ? 'Numbers refreshed' : 'Automatic check is not available for this account'); go('#/profile/social'); }); });
  $$('[data-rm]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Remove account?', 'It will no longer show on your profile.', 'Remove', true)) { try { await del(`/creators/me/social/${b.dataset.rm}`); go('#/profile/social'); } catch (e) { fail(e); } } }; });
}

async function rates() {
  const { data } = await get('/creators/me/rates');
  const types = (ctx.meta && ctx.meta.service_types) || {};
  const kinds = (ctx.meta && ctx.meta.rate_kinds) || ['content'];
  $('#tab').innerHTML = `
    <div class="panel">
      <div class="panel-head"><div><h2>Rate card</h2><p class="small muted" style="margin:0">Your starting prices. Brands see these, and the final deal price is agreed per offer.</p></div><button class="btn" id="add">Add rate</button></div>
      ${data.length ? `<div class="table-wrap" style="border:0"><table class="data"><thead><tr><th>Platform</th><th>Service</th><th>Type</th><th>Price</th><th></th></tr></thead><tbody>
        ${data.map((r) => `<tr><td>${esc(label(r.platform))}</td><td>${esc(label(r.service_type))}${r.description ? `<div class="small muted">${esc(r.description)}</div>` : ''}</td><td>${esc(label(r.rate_kind))}</td><td><b>${inr(r.price)}</b></td>
        <td class="nowrap"><button class="btn ghost small" data-edit="${r.ROWID}">Edit</button><button class="btn ghost small" data-rm="${r.ROWID}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
      : emptyState('Add at least one rate. Profiles with prices get more offers.')}
    </div>`;
  const open = (r = {}) => {
    const m = modal(r.ROWID ? 'Edit rate' : 'Add rate', `<form id="rf">
      <div class="grid-2">${select('platform', 'Platform', [...PLATFORMS, 'any'], r.platform || 'instagram')}${select('rate_kind', 'Type', kinds, r.rate_kind || 'content', { hint: 'Content, or an add-on like usage rights' })}</div>
      ${field('service_type', 'Service', { value: r.service_type || '', required: true, attrs: 'list="svc"', hint: 'e.g. reel, story, dedicated video' })}
      <datalist id="svc">${Object.values(types).flat().filter((v, i, a) => a.indexOf(v) === i).map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      ${field('price', 'Price (₹)', { type: 'number', value: r.price || '', required: true, attrs: 'min="0" step="1"' })}
      ${field('description', 'What\'s included (optional)', { value: r.description || '' })}
      <button class="btn" type="submit">Save rate</button></form>`);
    const f = $('#rf', m.el);
    f.onsubmit = (e) => { e.preventDefault(); save(); };
    const save = busy($('button[type=submit]', f), async () => {
      const d = formData(f);
      if (r.ROWID) await put(`/creators/me/rates/${r.ROWID}`, d); else await post('/creators/me/rates', d);
      m.close(); toast('Rate saved'); go('#/profile/rates');
    });
  };
  $('#add').onclick = () => open();
  $$('[data-edit]').forEach((b) => { b.onclick = () => open(data.find((x) => String(x.ROWID) === b.dataset.edit)); });
  $$('[data-rm]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Delete rate?', 'This price will be removed from your rate card.', 'Delete', true)) { try { await del(`/creators/me/rates/${b.dataset.rm}`); go('#/profile/rates'); } catch (e) { fail(e); } } }; });
}

async function portfolio() {
  const { data } = await get('/creators/me/portfolio');
  $('#tab').innerHTML = `
    <div class="panel">
      <div class="panel-head"><div><h2>Portfolio</h2><p class="small muted" style="margin:0">Past brand work and your best content, with results.</p></div><button class="btn" id="add">Add work</button></div>
      ${data.length ? `<div class="rows" style="border:0">${data.map((x) => `<div class="row"><div><div class="t">${esc(x.title)}${x.brand_name ? ` <span class="muted">for ${esc(x.brand_name)}</span>` : ''}</div>
        <div class="s">${esc(label(x.platform || ''))} ${x.views ? `· ${compact(x.views)} views` : ''} ${x.likes ? `· ${compact(x.likes)} likes` : ''} ${x.engagement_rate ? `· ${pct(x.engagement_rate)} engagement` : ''}</div>
        ${x.media_url ? `<a class="small" href="${esc(x.media_url)}" target="_blank" rel="noopener">View post</a>` : ''}</div>
        <button class="btn ghost small" data-rm="${x.ROWID}">Delete</button></div>`).join('')}</div>` : emptyState('Add 3–6 of your best pieces. Brand collaborations with results work best.')}
    </div>`;
  $('#add').onclick = () => {
    const m = modal('Add portfolio item', `<form id="pf">
      <div class="grid-2">${field('title', 'Title', { required: true })}${field('brand_name', 'Brand (if any)')}</div>
      <div class="grid-2">${select('platform', 'Platform', PLATFORMS, 'instagram')}${select('item_type', 'Type', ['brand_collaboration', 'organic_content', 'case_study', 'testimonial'], 'brand_collaboration')}</div>
      ${field('media_url', 'Link to the post', { type: 'url', attrs: 'placeholder="https://"' })}
      <div class="grid-3">${field('views', 'Views', { type: 'number' })}${field('likes', 'Likes', { type: 'number' })}${field('engagement_rate', 'Engagement %', { type: 'number', attrs: 'step="0.1"' })}</div>
      ${field('description', 'What you did and what happened', { type: 'textarea' })}
      <button class="btn" type="submit">Add to portfolio</button></form>`);
    const f = $('#pf', m.el);
    f.onsubmit = (e) => { e.preventDefault(); save(); };
    const save = busy($('button[type=submit]', f), async () => { await post('/creators/me/portfolio', formData(f)); m.close(); toast('Added to portfolio'); go('#/profile/portfolio'); });
  };
  $$('[data-rm]').forEach((b) => { b.onclick = async () => { if (await confirmBox('Delete item?', 'It will be removed from your portfolio.', 'Delete', true)) { try { await del(`/creators/me/portfolio/${b.dataset.rm}`); go('#/profile/portfolio'); } catch (e) { fail(e); } } }; });
}

async function availability() {
  const { data } = await get('/creators/me/availability');
  $('#tab').innerHTML = `
    <div class="panel">
      <div class="panel-head"><div><h2>Availability</h2><p class="small muted" style="margin:0">Mark dates you're booked or away so brands plan around them.</p></div><button class="btn" id="add">Add dates</button></div>
      ${data.length ? `<div class="rows" style="border:0">${data.map((x) => `<div class="row"><div><div class="t">${date(x.start_date)} – ${date(x.end_date)}</div><div class="s">${esc(x.note || '')}</div></div>
        <div class="btn-row"><span class="tag ${x.status === 'available' ? 'green' : x.status === 'booked' ? 'gold' : 'rose'}">${esc(label(x.status))}</span><button class="btn ghost small" data-rm="${x.ROWID}">Delete</button></div></div>`).join('')}</div>` : emptyState('No dates added. You\'re shown as available.')}
    </div>`;
  $('#add').onclick = () => {
    const m = modal('Add dates', `<form id="af"><div class="grid-2">${field('start_date', 'From', { type: 'date', required: true })}${field('end_date', 'To', { type: 'date', required: true })}</div>
      ${select('status', 'Status', ['available', 'booked', 'unavailable'], 'booked')}${field('note', 'Note (optional)')}<button class="btn" type="submit">Save dates</button></form>`);
    const f = $('#af', m.el);
    f.onsubmit = (e) => { e.preventDefault(); save(); };
    const save = busy($('button[type=submit]', f), async () => { await post('/creators/me/availability', formData(f)); m.close(); go('#/profile/availability'); });
  };
  $$('[data-rm]').forEach((b) => { b.onclick = async () => { try { await del(`/creators/me/availability/${b.dataset.rm}`); go('#/profile/availability'); } catch (e) { fail(e); } }; });
}

async function payout(p) {
  const c = p.creator;
  $('#tab').innerHTML = `
    <div class="panel">
      <h2>Payout account</h2>
      <p>Brand payments are held by our payment partner, Razorpay, and sent to your bank or UPI account when the brand approves your work.</p>
      <p><b>Status:</b> ${c.payouts_ready ? tag(c.kyc_status === 'verified' ? 'verified' : 'submitted') : '<span class="tag rose">Not set up</span>'}</p>
      <ol class="small" style="max-width:66ch;padding-left:18px">
        <li>Our team sends you a Razorpay link to add your bank or UPI details and PAN (KYC).</li>
        <li>Once Razorpay approves it, you get an account ID starting with <b>acc_</b>.</li>
        <li>Paste it below. You need this before a brand can pay for a deal with you.</li>
      </ol>
      <form id="po" class="btn-row" style="align-items:flex-end;max-width:520px">
        <label class="field" style="flex:1;margin:0"><span>Razorpay account ID</span><input name="razorpay_account_id" placeholder="acc_XXXXXXXXXXXXXX" pattern="acc_[A-Za-z0-9]{8,20}" required></label>
        <button class="btn" type="submit">Save</button>
      </form>
    </div>`;
  const f = $('#po');
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => { await put('/creators/me/payout-account', formData(f)); toast('Payout account saved'); go('#/profile/payout'); });
}

function previewModal(p) {
  import('./business.js').then((b) => {
    const m = modal('How brands see you', `<div id="pv"></div>`, { wide: true });
    b.renderCreatorProfile($('#pv', m.el), p, { preview: true });
  });
}

/* ---------------- Earnings ---------------- */
export async function earnings() {
  const w = await get('/wallet');
  main().innerHTML = `
    <div class="page-head"><div><h1>Earnings</h1><p>${esc(w.note || '')}</p></div></div>
    ${w.payouts_ready ? '' : `<div class="next-step rose"><h3>Set up your payout account</h3><p>Brands can't pay for deals with you until this is done.</p><a class="btn" href="#/profile/payout">Set up payouts</a></div>`}
    <div class="figures"><div class="figure money"><b>${inr(w.total_earned)}</b><span>Paid out to you</span></div><div class="figure"><b>${inr(w.pending)}</b><span>Held until approval</span></div></div>
    <h2>Transactions</h2>
    ${w.transactions.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Deal</th><th>Amount to you</th><th>Status</th></tr></thead><tbody>
      ${w.transactions.map((t) => `<tr><td>${date(t.CREATEDTIME)}</td><td><a href="#/deals/${t.deal_id}">View deal</a></td><td><b>${inr(t.net_amount)}</b></td><td>${tag(t.status)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="rows">${emptyState('No payments yet. Payments appear here once a brand secures money for a deal.')}</div>`}`;
}
