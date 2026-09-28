import { get, post, put, qs, upload } from '../api.js';
import { $, $$, esc, inr, compact, pct, label, date, tag, toast, fail, modal, formData, busy, field, select, chips, emptyState, avatar, isTrue } from '../ui.js';
import { ctx, go } from '../state.js';
import { dealRows, openOfferModal } from './deals.js';
import { platformMark } from '../icons.js';

const main = () => $('#main');

/* ---------------- Dashboard ---------------- */
export async function home() {
  const [d, deals, camps] = await Promise.all([get('/businesses/me/dashboard'), get('/deals?size=8'), get('/businesses/me/campaigns?size=5')]);
  const b = ctx.me.business;
  const review = deals.data.filter((x) => x.status === 'content_submitted');
  const toPay = deals.data.filter((x) => x.status === 'contract_signed' || (x.status === 'accepted' && !x.business_signed_at));
  main().innerHTML = `
    <div class="page-head"><div><h1>${esc(d.company)}</h1><p>${b.verification_status === 'verified' ? '<span class="verified">✓ Verified business</span>' : 'Get verified so creators trust your offers. <a href="#/company">Verify now</a>'}</p></div>
      <div class="btn-row"><a class="btn secondary" href="#/campaigns/new">New campaign</a><a class="btn" href="#/discover">Find creators</a></div></div>
    <div class="figures">
      <div class="figure"><b>${d.active_campaigns}</b><span>Active campaigns</span></div>
      <div class="figure"><b>${d.creators_working}</b><span>Creators working</span></div>
      <div class="figure"><b>${d.content_published}</b><span>Deals with content live</span></div>
      <div class="figure"><b>${inr(d.funds_held)}</b><span>Held in active deals</span></div>
      <div class="figure money"><b>${inr(d.total_spent)}</b><span>Total spent</span></div>
    </div>
    ${review.length ? `<div class="next-step"><h3>${review.length} deal${review.length > 1 ? 's have' : ' has'} content waiting for your review</h3><p>Approve it or ask for changes. Creators can't publish until you approve.</p><a class="btn money" href="#/deals/${review[0].ROWID}">Review content</a></div>` : ''}
    ${!review.length && toPay.length ? `<div class="next-step"><h3>Finish setting up ${esc(toPay[0].deal_number)}</h3><p>Sign the agreement and secure payment so the creator can start.</p><a class="btn money" href="#/deals/${toPay[0].ROWID}">Open deal</a></div>` : ''}
    <div class="cols">
      <div><div class="panel-head"><h2>Recent deals</h2><a class="btn ghost small" href="#/deals">All deals</a></div>
        ${deals.data.length ? dealRows(deals.data) : `<div class="rows">${emptyState('No deals yet. Find a creator and send your first offer.', '<a class="btn" href="#/discover">Find creators</a>')}</div>`}</div>
      <div><div class="panel"><div class="panel-head"><h3>Campaigns</h3><a class="btn ghost small" href="#/campaigns">All</a></div>
        ${camps.data.length ? camps.data.map((c) => `<a class="row" style="padding:8px 0" href="#/campaigns/${c.ROWID}"><div><div class="t">${esc(c.name)}</div><div class="s">${inr(c.committed_amount)} committed</div></div>${tag(c.status)}</a>`).join('') : '<p class="small muted">Group deals into a campaign to track spend and results together.</p><a class="btn secondary small" href="#/campaigns/new">Create campaign</a>'}
      </div></div>
    </div>`;
}

/* ---------------- Discover ---------------- */
let lastFilters = {};
export async function discover() {
  let cats = [];
  try { cats = (await get('/meta/categories?group=creator')).data; } catch { /* optional */ }
  const f = lastFilters;
  main().innerHTML = `
    <div class="page-head"><div><h1>Find creators</h1><p>Filter by audience, performance and price, then invite the ones that fit.</p></div></div>
    <form class="filters" id="ff">
      <div class="grid-4">
        ${field('q', 'Search', { value: f.q || '', attrs: 'placeholder="Name, @username or topic"' })}
        ${select('category', 'Category', cats.map((c) => c.name), f.category, { blank: 'Any category' })}
        ${select('platform', 'Platform', ['instagram', 'youtube', 'facebook', 'x', 'linkedin'], f.platform, { blank: 'Any platform' })}
        ${field('city', 'City', { value: f.city || '' })}
        ${select('followers', 'Audience size', [['1000-10000', 'Nano (1K–10K)'], ['10000-100000', 'Micro (10K–1L)'], ['100000-1000000', 'Mid (1L–10L)'], ['1000000-', 'Macro (10L+)']], f.followers, { blank: 'Any size' })}
        ${field('min_engagement', 'Min. engagement %', { type: 'number', value: f.min_engagement || '', attrs: 'min="0" step="0.5"' })}
        ${field('max_price', 'Starting price up to ₹', { type: 'number', value: f.max_price || '', attrs: 'min="0" step="500"' })}
        ${select('language', 'Language', ['Hindi', 'English', 'Gujarati', 'Marathi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Bengali', 'Punjabi'], f.language, { blank: 'Any language' })}
      </div>
      <div class="btn-row" style="margin-bottom:14px;justify-content:space-between">
        <div class="btn-row">
          <label class="small"><input type="checkbox" name="verified" value="1" ${f.verified ? 'checked' : ''}> Verified only</label>
          <label class="small"><input type="checkbox" name="available" value="1" ${f.available ? 'checked' : ''}> Available now</label>
        </div>
        <div class="btn-row">${select('sort', 'Sort by', [['followers', 'Biggest audience'], ['engagement', 'Highest engagement'], ['price', 'Lowest price'], ['rating', 'Best rated']], f.sort || 'followers').replace('<label class="field">', '<label class="field" style="margin:0;min-width:180px">')}
        <button class="btn" type="submit">Search</button></div>
      </div>
    </form>
    <div id="results"><div class="boot">Searching…</div></div>`;
  const form = $('#ff');
  form.onsubmit = (e) => { e.preventDefault(); lastFilters = formData(form); search(1); };
  search(1);
}

async function search(page) {
  const f = { ...lastFilters };
  if (f.followers) { const [a, b] = f.followers.split('-'); f.min_followers = a; f.max_followers = b; delete f.followers; }
  const box = $('#results');
  try {
    const { data } = await get('/discover/creators' + qs({ ...f, page, size: 24 }));
    if (!data.length) { box.innerHTML = `<div class="rows">${emptyState('No creators match these filters. Try widening the audience size or removing the city.')}</div>`; return; }
    box.innerHTML = `<div class="creator-grid">${data.map(card).join('')}</div>
      <div class="btn-row" style="justify-content:center;margin-top:20px">${page > 1 ? `<button class="btn secondary" data-page="${page - 1}">Previous</button>` : ''}${data.length === 24 ? `<button class="btn secondary" data-page="${page + 1}">Next page</button>` : ''}</div>`;
    $$('[data-page]', box).forEach((b) => { b.onclick = () => search(Number(b.dataset.page)); });
  } catch (e) { box.innerHTML = ''; fail(e); }
}

function card(c) {
  const prices = Object.entries(c.starting_prices || {}).sort((a, b) => a[1] - b[1]);
  const top = (c.social || []).slice().sort((a, b) => b.followers - a.followers).slice(0, 2);
  return `<div class="ccard">
    <div class="ccard-top">${avatar(c.full_name, c.photo_url)}<div><div class="t"><b>${esc(c.full_name)}</b> ${isTrue(c.is_verified) ? '<span class="verified" title="Verified">✓</span>' : ''}</div>
      <div class="small muted">@${esc(c.username)}${c.city ? ` · ${esc(c.city)}` : ''}</div></div></div>
    <div class="stats-line">${top.map((a) => `<div><b>${compact(a.followers)}</b>${platformMark(a.platform)} ${a.verified ? '<span class="verified">✓</span>' : ''}</div>`).join('')}<div><b>${pct(c.avg_engagement_rate)}</b>Engagement</div></div>
    ${c.categories ? `<div class="small muted">${esc(c.categories.split(',').slice(0, 3).join(', '))}</div>` : ''}
    <div class="from">${prices.length ? `From <b>${inr(prices[0][1])}</b> <span class="small muted">${esc(label(prices[0][0].split(':')[1]))}</span>` : '<span class="muted small">No rates listed</span>'}</div>
    <div class="btn-row" style="margin-top:auto"><a class="btn secondary small" href="#/creators/${c.ROWID}">View profile</a><button class="btn small" onclick="location.hash='#/creators/${c.ROWID}?offer=1'">Send offer</button></div>
  </div>`;
}

/* ---------------- Creator profile (as seen by brand) ---------------- */
export async function creatorProfile(id) {
  const p = await get('/creators/' + id);
  main().innerHTML = '<div id="cp"></div>';
  renderCreatorProfile($('#cp'), p, {});
  if (location.hash.includes('offer=1')) openOffer(p);
}

export function renderCreatorProfile(root, p, { preview }) {
  const c = p.creator;
  const byPlatform = {};
  p.rates.filter((r) => isTrue(r.is_active) || r.is_active === undefined).forEach((r) => { (byPlatform[r.platform] = byPlatform[r.platform] || []).push(r); });
  const booked = p.availability.filter((a) => a.status !== 'available');
  root.innerHTML = `
    <div class="panel" style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">
      ${avatar(c.full_name, c.photo_url, 'lg')}
      <div style="flex:1;min-width:220px">
        <h1 style="margin:0">${esc(c.full_name)} ${isTrue(c.is_verified) ? '<span class="verified" style="font-size:16px">✓ Verified creator</span>' : ''}</h1>
        <div class="muted">@${esc(c.username)}${c.city ? ` · ${esc(c.city)}, ${esc(c.state || c.country || '')}` : ''}</div>
        <div class="small" style="margin-top:6px">${esc((c.categories || '').split(',').join(' · '))}${c.languages ? ` — speaks ${esc(c.languages.split(',').join(', '))}` : ''}</div>
      </div>
      ${preview ? '' : `<div class="btn-row">${isTrue(c.is_available) ? '' : '<span class="tag gold">Not taking new work right now</span>'}<button class="btn money" id="offer">Send collaboration offer</button></div>`}
    </div>
    <div class="figures">
      <div class="figure"><b>${compact(c.total_followers)}</b><span>Total audience</span></div>
      <div class="figure"><b>${pct(c.avg_engagement_rate)}</b><span>Avg. engagement</span></div>
      ${p.social.slice(0, 3).map((a) => `<div class="figure"><b>${compact(a.followers)}</b><span>${esc(label(a.platform))} ${a.verified ? '✓' : '(self-reported)'}</span></div>`).join('')}
      ${c.avg_rating ? `<div class="figure"><b>${Number(c.avg_rating).toFixed(1)}★</b><span>${p.reviews.length} review${p.reviews.length === 1 ? '' : 's'}</span></div>` : ''}
    </div>
    <div class="cols">
      <div>
        ${c.bio ? `<div class="panel"><h3>About</h3><p>${esc(c.bio)}</p></div>` : ''}
        <div class="panel"><h3>Accounts</h3>
          ${p.social.length ? `<table class="data"><thead><tr><th>Platform</th><th>Followers</th><th>Avg. views</th><th>Engagement</th></tr></thead><tbody>${p.social.map((a) => `<tr><td>${platformMark(a.platform)} ${esc(label(a.platform))} <span class="muted small">@${esc(a.handle)}</span>${a.profile_url ? ` <a class="small" href="${esc(a.profile_url)}" target="_blank" rel="noopener">Open</a>` : ''}</td><td>${compact(a.followers)}</td><td>${compact(a.avg_views)}</td><td>${pct(a.engagement_rate)}</td></tr>`).join('')}</tbody></table>
          <p class="small muted" style="margin:10px 0 0">✓ means we checked the numbers with the platform. Other figures are provided by the creator.</p>` : '<p class="muted">No accounts connected yet.</p>'}
        </div>
        <div class="panel"><h3>Portfolio</h3>
          ${p.portfolio.length ? p.portfolio.map((x) => `<div class="row" style="padding:10px 0"><div><div class="t">${esc(x.title)}${x.brand_name ? ` <span class="muted">for ${esc(x.brand_name)}</span>` : ''}</div><div class="s">${x.views ? `${compact(x.views)} views ` : ''}${x.engagement_rate ? `· ${pct(x.engagement_rate)} engagement` : ''} ${x.description ? '— ' + esc(x.description) : ''}</div></div>${x.media_url ? `<a class="btn ghost small" href="${esc(x.media_url)}" target="_blank" rel="noopener">View</a>` : ''}</div>`).join('') : '<p class="muted">No portfolio items yet.</p>'}
        </div>
        <div class="panel"><h3>Reviews from brands</h3>
          ${p.reviews.length ? p.reviews.map((r) => `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><b>${Number(r.overall).toFixed(1)}★</b> <span class="small muted">${date(r.CREATEDTIME)}</span><div class="small muted">Quality ${r.score_quality} · Communication ${r.score_communication} · Professionalism ${r.score_professionalism} · On time ${r.score_timeliness}</div>${r.comment ? `<p style="margin:6px 0 0">${esc(r.comment)}</p>` : ''}</div>`).join('') : '<p class="muted">No reviews yet.</p>'}
        </div>
      </div>
      <div>
        <div class="panel"><h3>Rate card</h3>
          ${Object.keys(byPlatform).length ? Object.entries(byPlatform).map(([pl, rs]) => `<div style="margin-bottom:12px"><div class="small muted" style="font-weight:600">${esc(label(pl))}</div><table class="lines">${rs.map((r) => `<tr><td>${esc(label(r.service_type))}${r.rate_kind !== 'content' ? ` <span class="small muted">(${esc(label(r.rate_kind))})</span>` : ''}</td><td>${inr(r.price)}</td></tr>`).join('')}</table></div>`).join('') : '<p class="muted small">No rates listed. You can still send an offer.</p>'}
          <p class="small muted" style="margin:0">Starting prices. The final price is agreed in the offer.</p>
        </div>
        ${booked.length ? `<div class="panel"><h3>Busy dates</h3>${booked.map((a) => `<div class="small">${date(a.start_date)} – ${date(a.end_date)}: ${esc(label(a.status))}</div>`).join('')}</div>` : ''}
      </div>
    </div>`;
  const btn = $('#offer', root);
  if (btn) btn.onclick = () => openOffer(p);
}

async function openOffer(p) {
  let campaigns = [];
  try { campaigns = (await get('/businesses/me/campaigns?status=active&size=50')).data.concat((await get('/businesses/me/campaigns?status=draft&size=50')).data); } catch { /* optional */ }
  openOfferModal({
    title: `Offer to ${p.creator.full_name}`,
    campaigns,
    rates: p.rates,
    onSubmit: async (terms) => {
      const r = await post('/deals', { creator_id: p.creator.ROWID, ...terms });
      toast('Offer sent');
      go('#/deals/' + r.deal.ROWID);
    },
  });
}

/* ---------------- Campaigns ---------------- */
export async function campaigns() {
  const { data } = await get('/businesses/me/campaigns?size=100');
  main().innerHTML = `
    <div class="page-head"><div><h1>Campaigns</h1><p>Group deals to track budget, content and results in one place.</p></div><a class="btn" href="#/campaigns/new">New campaign</a></div>
    ${data.length ? `<div class="rows">${data.map((c) => `<a class="row" href="#/campaigns/${c.ROWID}"><div><div class="t">${esc(c.name)}</div><div class="s">${esc(label(c.goal || ''))} ${c.platforms ? '· ' + esc(c.platforms.split(',').map(label).join(', ')) : ''} · Budget ${inr(c.budget_min)}–${inr(c.budget_max)} · ${inr(c.committed_amount)} committed</div></div>${tag(c.status)}</a>`).join('')}</div>`
      : `<div class="rows">${emptyState('No campaigns yet.', '<a class="btn" href="#/campaigns/new">Create your first campaign</a>')}</div>`}`;
}

export async function campaignForm(id) {
  const c = id ? (await get('/businesses/me/campaigns/' + id)).campaign : {};
  const aud = (() => { try { return JSON.parse(c.target_audience_json || '{}'); } catch { return {}; } })();
  main().innerHTML = `
    <div class="page-head"><div><h1>${id ? 'Edit campaign' : 'New campaign'}</h1><p>Answer a few questions. You can change everything later.</p></div></div>
    <form id="cf">
      <div class="panel"><h3>1. What are you promoting?</h3>
        ${field('name', 'Campaign name', { value: c.name || '', required: true, attrs: 'placeholder="e.g. Diwali 2026 launch"' })}
        <div class="grid-2">${select('promotion_type', 'Promoting a', (ctx.meta.promotion_types || ['product']), c.promotion_type || 'product')}${select('goal', 'Main goal', (ctx.meta.campaign_goals || ['brand_awareness']), c.goal || 'brand_awareness')}</div>
        ${field('product_name', 'Product or service name', { value: c.product_name || '' })}
      </div>
      <div class="panel"><h3>2. Where and what content?</h3>
        <label class="field"><span>Platforms</span>${chips('platforms', ['instagram', 'youtube', 'facebook', 'x', 'linkedin'], c.platforms)}</label>
        <label class="field"><span>Content types</span>${chips('content_types', ['reel', 'story', 'post', 'carousel', 'video', 'short', 'review', 'live'], c.content_types)}</label>
      </div>
      <div class="panel"><h3>3. Who should it reach?</h3>
        <div class="grid-3">${select('aud_age', 'Age', ['13-17', '18-24', '18-35', '25-34', '35-44', '45+', 'all'], aud.age || '18-35')}${select('aud_gender', 'Gender', ['all', 'female', 'male'], aud.gender || 'all')}${field('aud_location', 'Location', { value: aud.location || 'India' })}</div>
        ${field('aud_interests', 'Interests', { value: aud.interests || '', attrs: 'placeholder="fitness, gadgets, home cooking"' })}
      </div>
      <div class="panel"><h3>4. Budget and dates</h3>
        <div class="grid-2">${field('budget_min', 'Budget from (₹)', { type: 'number', value: c.budget_min || '', attrs: 'min="0" step="1000"' })}${field('budget_max', 'Budget up to (₹)', { type: 'number', value: c.budget_max || '', attrs: 'min="0" step="1000"' })}</div>
        <div class="grid-2">${field('start_date', 'Start', { type: 'date', value: c.start_date || '' })}${field('end_date', 'End', { type: 'date', value: c.end_date || '' })}</div>
      </div>
      <div class="panel"><h3>5. Brief for creators</h3>
        ${field('brief', 'Campaign brief', { type: 'textarea', value: c.brief || '', hint: 'Key message, must-show product shots, hashtags, tags, things to avoid. This is copied into every offer.', attrs: 'rows="7"' })}
        ${id ? select('status', 'Status', ['draft', 'active', 'paused', 'completed', 'archived'], c.status) : ''}
      </div>
      <div class="btn-row"><button class="btn" type="submit">${id ? 'Save campaign' : 'Create campaign and find creators'}</button><a class="btn secondary" href="#/campaigns">Cancel</a></div>
    </form>`;
  const f = $('#cf');
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => {
    const d = formData(f);
    const body = { ...d, platforms: d.platforms || [], content_types: d.content_types || [],
      target_audience: { age: d.aud_age, gender: d.aud_gender, location: d.aud_location, interests: d.aud_interests } };
    ['aud_age', 'aud_gender', 'aud_location', 'aud_interests'].forEach((k) => delete body[k]);
    ['budget_min', 'budget_max', 'start_date', 'end_date'].forEach((k) => { if (body[k] === '') delete body[k]; });
    if (id) { await put('/businesses/me/campaigns/' + id, body); toast('Campaign saved'); go('#/campaigns/' + id); }
    else {
      const r = await post('/businesses/me/campaigns', { ...body });
      await put('/businesses/me/campaigns/' + r.ROWID, { status: 'active' });
      toast('Campaign created');
      lastFilters = { platform: (body.platforms || [])[0] || '' };
      go('#/discover');
    }
  });
}

export async function campaignPage(id) {
  const r = await get('/businesses/me/campaigns/' + id);
  const c = r.campaign;
  const s = r.stats;
  main().innerHTML = `
    <div class="page-head"><div><h1>${esc(c.name)}</h1><p>${tag(c.status)} ${esc(label(c.goal || ''))} · ${date(c.start_date)} – ${date(c.end_date)}</p></div>
      <div class="btn-row"><a class="btn secondary" href="#/campaigns/${id}/edit">Edit</a><a class="btn" href="#/discover">Add creators</a></div></div>
    <div class="figures">
      <div class="figure"><b>${s.creators}</b><span>Creators</span></div>
      <div class="figure money"><b>${inr(s.committed)}</b><span>Committed of ${inr(c.budget_max)}</span></div>
      <div class="figure"><b>${s.deliverables_published}/${s.deliverables_total}</b><span>Content live</span></div>
      <div class="figure"><b>${compact(s.views)}</b><span>Views</span></div>
      <div class="figure"><b>${compact(s.reach)}</b><span>Reach</span></div>
      <div class="figure"><b>${pct(s.engagement_rate)}</b><span>Engagement</span></div>
      <div class="figure"><b>${s.cost_per_1k_reach ? inr(s.cost_per_1k_reach) : '—'}</b><span>Cost per 1,000 reach</span></div>
    </div>
    <h2>Creators in this campaign</h2>
    ${r.deals.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Creator</th><th>Deal</th><th>Amount</th><th>Status</th></tr></thead><tbody>
      ${r.deals.map((d) => `<tr><td>${d.creator ? `<b>${esc(d.creator.full_name)}</b><div class="small muted">@${esc(d.creator.username)} · ${compact(d.creator.total_followers)}</div>` : '—'}</td><td><a href="#/deals/${d.ROWID}">${esc(d.deal_number)}</a></td><td>${inr(d.agreed_amount)}</td><td>${tag(d.status)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="rows">${emptyState('No creators yet. Send offers from a creator\'s profile and pick this campaign.', '<a class="btn" href="#/discover">Find creators</a>')}</div>`}
    ${c.brief ? `<div class="panel" style="margin-top:20px"><h3>Brief</h3><p style="white-space:pre-wrap">${esc(c.brief)}</p></div>` : ''}
    <p class="small muted">Results come from the numbers creators report after publishing, or that our team enters from platform insights.</p>`;
}

/* ---------------- Payments ---------------- */
export async function payments() {
  const w = await get('/wallet');
  main().innerHTML = `
    <div class="page-head"><div><h1>Payments</h1><p>Money you pay is held by Razorpay and only released to the creator after you approve the content.</p></div></div>
    <div class="figures"><div class="figure"><b>${inr(w.funds_held)}</b><span>Held in active deals</span></div><div class="figure money"><b>${inr(w.completed_spend)}</b><span>Released to creators</span></div></div>
    ${w.transactions.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Deal</th><th>You paid</th><th>Platform fee</th><th>GST on fee</th><th>Creator gets</th><th>Status</th></tr></thead><tbody>
      ${w.transactions.map((t) => `<tr><td>${date(t.CREATEDTIME)}</td><td><a href="#/deals/${t.deal_id}">View deal</a></td><td><b>${inr(t.gross_amount)}</b></td><td>${inr(t.platform_fee)}</td><td>${inr(t.tax_amount)}</td><td>${inr(t.net_amount)}</td><td>${tag(t.status)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="rows">${emptyState('No payments yet. You pay after both sides sign a deal\'s agreement.')}</div>`}`;
}

/* ---------------- Company profile + verification ---------------- */
export async function company() {
  const b = await get('/businesses/me');
  let cats = [];
  try { cats = (await get('/meta/categories?group=business')).data; } catch { /* optional */ }
  main().innerHTML = `
    <div class="page-head"><div><h1>Company profile</h1><p>Creators see this when they receive your offers.</p></div></div>
    <div class="cols">
      <form class="panel" id="bf">
        <div style="display:flex;gap:16px;align-items:center;margin-bottom:16px">${avatar(b.company_name, b.logo_url, 'lg')}<label class="btn secondary small" style="cursor:pointer">Upload logo<input type="file" id="logo" accept="image/jpeg,image/png,image/webp" hidden></label></div>
        ${field('company_name', 'Business name', { value: b.company_name, required: true })}
        <div class="grid-2">${select('category', 'Category', cats.map((c) => c.name), b.category, { blank: 'Choose' })}${field('website', 'Website', { type: 'url', value: b.website || '' })}</div>
        <div class="grid-2">${field('contact_email', 'Contact email', { type: 'email', value: b.contact_email || '' })}${field('contact_phone', 'Phone', { type: 'tel', value: b.contact_phone || '' })}</div>
        ${field('address', 'Address', { type: 'textarea', value: b.address || '' })}
        <div class="grid-3">${field('city', 'City', { value: b.city || '' })}${field('state', 'State', { value: b.state || '' })}${field('country', 'Country', { value: b.country || 'India' })}</div>
        ${field('gstin', 'GSTIN', { value: b.gstin || '', attrs: 'maxlength="15"' })}
        ${field('about', 'About', { type: 'textarea', value: b.about || '' })}
        <button class="btn" type="submit">Save changes</button>
      </form>
      <div class="panel"><h3>Verification</h3>
        <p>Status: ${tag(b.verification_status || 'pending')}</p>
        ${b.verification_status === 'verified' ? '<p class="small">Your business shows a verified badge on every offer.</p>' : `
        <p class="small">Upload a GST certificate, incorporation certificate, or Udyam registration. Our team checks it within 2 working days.</p>
        <input type="file" id="docs" accept="application/pdf,image/*" multiple>
        <button class="btn" id="send-docs" style="margin-top:10px">Submit for verification</button>`}
      </div>
    </div>`;
  const f = $('#bf');
  f.onsubmit = (e) => { e.preventDefault(); save(); };
  const save = busy($('button[type=submit]', f), async () => { await put('/businesses/me', formData(f)); toast('Company profile saved'); });
  $('#logo').onchange = async (e) => { const file = e.target.files[0]; if (!file) return; try { const key = await upload(file, 'logo'); await put('/businesses/me', { logo_url: key }); toast('Logo updated'); go('#/company'); } catch (err) { fail(err); } };
  const sd = $('#send-docs');
  if (sd) sd.onclick = busy(sd, async () => {
    const files = [...$('#docs').files];
    if (!files.length) throw new Error('Choose at least one document');
    const keys = [];
    for (const file of files) keys.push(await upload(file, 'kyc'));
    await post('/businesses/me/verification', { document_keys: keys });
    toast('Documents submitted for verification');
    go('#/company');
  });
}
