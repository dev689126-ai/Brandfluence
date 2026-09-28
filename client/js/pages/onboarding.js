import { get, post, auth } from '../api.js';
import { $, esc, field, select, chips, formData, busy, toast } from '../ui.js';
import { ctx } from '../state.js';

const STATES = ['Andhra Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Other'];
const LANGS = ['Hindi', 'English', 'Gujarati', 'Marathi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Bengali', 'Punjabi', 'Odia'];

export async function renderOnboarding() {
  const me = ctx.me;
  $('#app').innerHTML = `
  <div class="onboard">
    <a class="brand" href="#" style="color:var(--ink);padding:0 0 28px"><i></i>Brandfluence</a>
    <h1>What are you here to do?</h1>
    <p class="muted">Signed in as ${esc(me.user.email)}. You can't switch this later, so pick the one that fits.</p>
    <div class="role-pick">
      <button data-role="creator"><b>I'm a creator</b>Get brand deals, agree your price, and get paid safely for your content.</button>
      <button data-role="business"><b>I'm a business</b>Find creators, run campaigns, and pay only for approved content.</button>
    </div>
    ${me.can_be_admin ? '<button class="btn ghost" data-role="admin">Set up as platform administrator</button>' : ''}
    <div id="ob-form"></div>
    <p style="margin-top:30px"><button class="btn ghost small" id="ob-out">Sign out</button></p>
  </div>`;
  $('#ob-out').onclick = auth.logout;
  document.querySelectorAll('[data-role]').forEach((b) => { b.onclick = () => form(b.dataset.role); });
}

async function form(role) {
  const box = $('#ob-form');
  if (role === 'admin') {
    box.innerHTML = `<div class="panel"><p>Admins manage users, verifications, payments and disputes.</p><button class="btn" id="ob-go">Continue as admin</button></div>`;
    $('#ob-go').onclick = busy($('#ob-go'), async () => { await post('/me/onboard', { role: 'admin' }); location.hash = '#/admin'; location.reload(); });
    return;
  }
  let cats = [];
  let types = [];
  try {
    [cats, types] = await Promise.all([
      get('/meta/categories?group=' + (role === 'creator' ? 'creator' : 'business')).then((r) => r.data),
      role === 'creator' ? get('/meta/categories?group=creator_type').then((r) => r.data) : [],
    ]);
  } catch { /* lists optional */ }
  const name = [ctx.me.user.first_name, ctx.me.user.last_name].filter(Boolean).join(' ');
  box.innerHTML = role === 'creator' ? `
    <form class="panel" id="ob">
      <h2>Your creator profile</h2>
      <div class="grid-2">${field('full_name', 'Full name', { value: name, required: true })}${field('username', 'Username', { required: true, hint: 'Letters, numbers, dots and underscores', attrs: 'pattern="[A-Za-z0-9._]{3,40}"' })}</div>
      ${field('bio', 'Short bio', { type: 'textarea', hint: 'What you create and who watches it. Brands read this first.' })}
      <div class="grid-3">${field('city', 'City')}${select('state', 'State', STATES, '', { blank: 'Choose' })}${field('country', 'Country', { value: 'India' })}</div>
      <label class="field"><span>Categories</span>${chips('categories', cats.map((c) => c.name))}</label>
      <label class="field"><span>You are a…</span>${chips('creator_types', types.map((c) => c.name))}</label>
      <label class="field"><span>Languages you create in</span>${chips('languages', LANGS)}</label>
      ${field('phone', 'Mobile number', { type: 'tel', hint: 'Used for deal alerts', attrs: 'pattern="[0-9+ ]{10,15}"' })}
      <button class="btn" type="submit">Create my profile</button>
    </form>` : `
    <form class="panel" id="ob">
      <h2>Your business</h2>
      ${field('company_name', 'Business name', { required: true })}
      <div class="grid-2">${select('category', 'Category', cats.map((c) => c.name), '', { blank: 'Choose' })}${field('website', 'Website', { type: 'url', attrs: 'placeholder="https://"' })}</div>
      <div class="grid-2">${field('contact_email', 'Contact email', { type: 'email', value: ctx.me.user.email })}${field('phone', 'Phone', { type: 'tel' })}</div>
      <div class="grid-3">${field('city', 'City')}${select('state', 'State', STATES, '', { blank: 'Choose' })}${field('country', 'Country', { value: 'India' })}</div>
      ${field('gstin', 'GSTIN (optional)', { hint: '15 characters. Needed for GST invoices.', attrs: 'maxlength="15"' })}
      ${field('about', 'About your business', { type: 'textarea' })}
      <button class="btn" type="submit">Create business account</button>
    </form>`;
  const f = $('#ob');
  f.onsubmit = (e) => { e.preventDefault(); submit(); };
  const submit = busy($('button[type=submit]', f), async () => {
    const d = formData(f);
    const body = { role, phone: d.phone };
    if (role === 'creator') body.creator = { ...d, categories: d.categories || [], creator_types: d.creator_types || [], languages: d.languages || [] };
    else body.business = { ...d, contact_phone: d.phone };
    await post('/me/onboard', body);
    toast('Welcome to Brandfluence!');
    location.hash = '#/home';
    location.reload();
  });
  f.scrollIntoView({ behavior: 'smooth' });
}
