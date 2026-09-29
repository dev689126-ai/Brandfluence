// Creator Pro: find brands, brand page with open campaigns, plan & checkout, profile viewers
import { get, post, qs } from '../api.js';
import { $, $$, esc, inr, label, date, toast, fail, formData, busy, field, select, emptyState, avatar } from '../ui.js';
import { ctx, go } from '../state.js';
import { icon } from '../icons.js';
import { startChatModal, pitchBar, proBadge } from './chat.js';
import { loadScript } from './deals.js';

const main = () => $('#main');

/* ---------------- Find brands ---------------- */
let brandFilters = {};
export async function brands() {
  let cats = [];
  try { cats = (await get('/meta/categories?group=business')).data; } catch { /* optional */ }
  const f = brandFilters;
  const plan = ctx.me.plan;
  main().innerHTML = `
    <div class="page-head"><div><h1>Find brands</h1><p>Browse businesses on Brandfluence and pitch the ones that fit your audience.</p></div><a class="btn secondary" href="#/messages">My chats</a></div>
    ${plan ? pitchBar(plan) : ''}
    <form class="filters" id="bf"><div class="grid-4">
      ${field('q', 'Search', { value: f.q || '', attrs: 'placeholder="Brand name or product"' })}
      ${select('category', 'Category', cats.map((c) => c.name), f.category, { blank: 'Any category' })}
      ${field('city', 'City', { value: f.city || '' })}
      <label class="field" style="padding-top:26px"><input type="checkbox" name="verified" value="1" ${f.verified ? 'checked' : ''}> Verified brands only</label>
    </div><div class="btn-row" style="justify-content:flex-end;margin-bottom:14px"><button class="btn" type="submit">Search</button></div></form>
    <div id="bresults"><div class="boot">Loading brands…</div></div>`;
  const form = $('#bf');
  form.onsubmit = (e) => { e.preventDefault(); brandFilters = formData(form); searchBrands(1); };
  searchBrands(1);
}

async function searchBrands(page) {
  const box = $('#bresults');
  try {
    const { data } = await get('/businesses/directory' + qs({ ...brandFilters, page, size: 24 }));
    if (!data.length) { box.innerHTML = `<div class="rows">${emptyState('No brands match. Try another city or category.')}</div>`; return; }
    box.innerHTML = `<div class="creator-grid">${data.map((b) => `<div class="ccard">
      <div class="ccard-top">${avatar(b.company_name, b.logo_url)}<div><div class="t"><b>${esc(b.company_name)}</b> ${b.verified ? '<span class="verified" title="Verified business">✓</span>' : ''}</div>
        <div class="small muted">${esc([b.category, b.city].filter(Boolean).join(' · '))}</div></div></div>
      ${b.about ? `<p class="small" style="margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(b.about)}</p>` : ''}
      <div class="small">${b.open_campaigns ? `<span class="tag green">${b.open_campaigns} open campaign${b.open_campaigns > 1 ? 's' : ''}</span>` : '<span class="muted">No open campaigns right now</span>'}</div>
      <div class="btn-row" style="margin-top:auto"><a class="btn secondary small" href="#/brands/${b.ROWID}">View brand</a><button class="btn small" data-pitch="${b.ROWID}" data-name="${esc(b.company_name)}">Pitch</button></div>
    </div>`).join('')}</div>
    <div class="btn-row" style="justify-content:center;margin-top:20px">${page > 1 ? `<button class="btn secondary" data-page="${page - 1}">Previous</button>` : ''}${data.length === 24 ? `<button class="btn secondary" data-page="${page + 1}">Next page</button>` : ''}</div>`;
    $$('[data-page]', box).forEach((b) => { b.onclick = () => searchBrands(Number(b.dataset.page)); });
    $$('[data-pitch]', box).forEach((b) => { b.onclick = () => startChatModal({ to: { business_id: b.dataset.pitch }, name: b.dataset.name }); });
  } catch (e) { box.innerHTML = ''; fail(e); }
}

/* ---------------- One brand ---------------- */
export async function brandPage(id) {
  const r = await get('/businesses/' + id);
  const b = r.business;
  main().innerHTML = `
    <div class="panel" style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">
      ${avatar(b.company_name, b.logo_url, 'lg')}
      <div style="flex:1;min-width:220px"><h1 style="margin:0">${esc(b.company_name)} ${b.verification_status === 'verified' ? '<span class="verified" style="font-size:16px">✓ Verified business</span>' : ''}</h1>
        <div class="muted">${esc([b.category, b.city, b.state].filter(Boolean).join(' · '))}</div>
        ${b.website ? `<a class="small" href="${esc(/^https?:/i.test(b.website) ? b.website : 'https://' + b.website)}" target="_blank" rel="noopener">${esc(b.website)}</a>` : ''}</div>
      <div class="btn-row">${r.open_chat_id ? `<a class="btn" href="#/messages/${r.open_chat_id}">Open chat</a>` : '<button class="btn money" id="pitch">Pitch this brand</button>'}</div>
    </div>
    <div class="figures">
      <div class="figure"><b>${r.completed_deals || 0}</b><span>Deals completed here</span></div>
      <div class="figure"><b>${r.campaigns_count || 0}</b><span>Open campaigns</span></div>
      ${r.reviews.length ? `<div class="figure"><b>${(r.reviews.reduce((s, x) => s + Number(x.overall || 0), 0) / r.reviews.length).toFixed(1)}★</b><span>From ${r.reviews.length} creator review${r.reviews.length > 1 ? 's' : ''}</span></div>` : ''}
    </div>
    <div class="cols"><div>
      ${b.about ? `<div class="panel"><h3>About</h3><p>${esc(b.about)}</p></div>` : ''}
      <div class="panel"><h3>Open campaigns</h3>
        ${r.campaigns_locked ? `<div class="locked"><p>${icon('shield', 16)} This brand has <b>${r.campaigns_count}</b> open campaign${r.campaigns_count > 1 ? 's' : ''}. Pro creators can see each campaign's brief, platforms and budget, and pitch for it directly.</p><a class="btn money small" href="#/plan">Upgrade to Pro</a></div>`
          : r.campaigns && r.campaigns.length ? r.campaigns.map((c) => `<div class="row" style="padding:12px 0;align-items:flex-start"><div><div class="t">${esc(c.name)}</div>
            <div class="s">${esc(label(c.goal || ''))}${c.platforms ? ' · ' + esc(c.platforms.split(',').map(label).join(', ')) : ''}${c.budget_max ? ` · Budget ${inr(c.budget_min)}–${inr(c.budget_max)}` : ''}${c.end_date ? ` · until ${date(c.end_date)}` : ''}</div>
            ${c.brief ? `<p class="small" style="margin:6px 0 0">${esc(c.brief)}</p>` : ''}</div>
            ${r.open_chat_id ? '' : `<button class="btn small" data-camp="${esc(c.name)}">Pitch for this</button>`}</div>`).join('')
          : '<p class="muted">No open campaigns right now. You can still pitch an idea.</p>'}
      </div>
      <div class="panel"><h3>What creators say</h3>
        ${r.reviews.length ? r.reviews.map((x) => `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><b>${Number(x.overall).toFixed(1)}★</b> <span class="small muted">${date(x.CREATEDTIME)}</span>${x.comment ? `<p style="margin:6px 0 0">${esc(x.comment)}</p>` : ''}</div>`).join('') : '<p class="muted">No reviews yet.</p>'}
      </div>
    </div><div>${r.plan ? pitchBar(r.plan) : ''}</div></div>`;
  const pitch = () => startChatModal({ to: { business_id: b.ROWID }, name: b.company_name });
  const btn = $('#pitch');
  if (btn) btn.onclick = pitch;
  $$('[data-camp]').forEach((x) => { x.onclick = () => startChatModal({ to: { business_id: b.ROWID }, name: b.company_name, subjectHint: `About your campaign: ${x.dataset.camp}`.slice(0, 200) }); });
}

/* ---------------- Plan & upgrade ---------------- */
export async function planPage() {
  const p = await get('/plans/me');
  const saving = Math.max(0, p.prices.month * 12 - p.prices.year);
  main().innerHTML = `
    <div class="page-head"><div><h1>${p.is_pro ? 'You are a Pro creator' : 'Go Pro'}</h1><p>${p.is_pro ? `Pro is active until <b>${date(p.expires_at)}</b>. You can extend it any time.` : 'Stop waiting for offers. Pitch the brands you want to work with.'}</p></div></div>
    <div class="plans">
      <div class="plan-card"><h2>Free</h2><div class="price">₹0</div>
        <ul>${p.features.free.map((x) => `<li>${icon('check', 16)} ${esc(x)}</li>`).join('')}</ul>
        ${p.is_pro ? '' : '<span class="tag">Your plan</span>'}</div>
      <div class="plan-card pro"><h2>Pro ${proBadge()}</h2>
        <div class="price">${inr(p.prices.month)}<span>/month</span></div>
        <div class="small">or ${inr(p.prices.year)} a year${saving ? ` (save ${inr(saving)})` : ''}</div>
        <ul>${p.features.pro.map((x) => `<li>${icon('check', 16)} ${esc(x)}</li>`).join('')}</ul>
        <div class="btn-row"><button class="btn money" data-buy="month">${p.is_pro ? 'Add 1 month' : 'Get Pro monthly'}</button><button class="btn secondary" data-buy="year">${p.is_pro ? 'Add 1 year' : 'Get Pro yearly'}</button></div>
        ${p.payments_enabled ? '' : '<p class="small muted" style="margin-top:10px">Online payment is being set up. Contact support to upgrade in the meantime.</p>'}
      </div>
    </div>
    <div class="panel"><h3>This month</h3><p>${p.pitches.used} pitch${p.pitches.used === 1 ? '' : 'es'} sent, ${p.pitches.left} left. Replying to brands who message you never uses a pitch.</p></div>
    ${p.history.length ? `<h2>Payments</h2><div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Valid until</th></tr></thead><tbody>
      ${p.history.map((h) => `<tr><td>${date(h.starts_at || h.CREATEDTIME)}</td><td>Pro, ${h.period === 'year' ? '1 year' : '1 month'}${h.source === 'admin' ? ' (added by Brandfluence)' : ''}</td><td>${inr(h.amount)}</td><td>${date(h.ends_at)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $$('[data-buy]').forEach((b) => { b.onclick = busy(b, () => buy(b.dataset.buy)); });
}

async function buy(period) {
  const o = await post('/plans/checkout', { period });
  await loadScript('https://checkout.razorpay.com/v1/checkout.js');
  await new Promise((resolve) => {
    const rzp = new window.Razorpay({
      key: o.key_id, order_id: o.order_id, amount: o.amount, currency: o.currency, name: o.name, description: o.description,
      prefill: { email: ctx.me.user.email },
      theme: { color: '#E6197A' },
      handler: async (resp) => {
        try {
          const r = await post('/plans/verify', resp);
          ctx.me = await get('/me');
          toast(`Pro is active until ${date(r.ends_at)}`);
        } catch (e) { fail(e); }
        resolve(); go('#/plan');
      },
      modal: { ondismiss: resolve },
    });
    rzp.on('payment.failed', (resp) => { fail(new Error((resp.error && resp.error.description) || 'Payment failed')); });
    rzp.open();
  });
}

/* ---------------- Profile viewers (creator home widget) ---------------- */
export async function viewsPanel() {
  try {
    const v = await get('/creators/me/views');
    return `<div class="panel"><div class="panel-head"><h3>Profile views</h3>${v.locked ? '' : proBadge()}</div>
      <p style="margin:0 0 8px"><b>${v.brands}</b> brand${v.brands === 1 ? '' : 's'} viewed your profile in the last ${v.days} days.</p>
      ${v.locked ? (v.brands ? '<p class="small muted">See which brands looked, and pitch them while you are on their mind.</p><a class="btn money small" href="#/plan">See who with Pro</a>' : '')
        : v.data.map((b) => `<a class="row" style="padding:8px 0" href="#/brands/${b.ROWID}"><div style="display:flex;gap:10px;align-items:center">${avatar(b.company_name, b.logo_url, 'sm')}<div><div class="t">${esc(b.company_name)}</div><div class="s">${esc(b.city || '')} · ${date(b.last_viewed)}</div></div></div></a>`).join('')}
    </div>`;
  } catch { return ''; }
}
