import { get, ApiError } from './api.js';
import { esc, $, fail, avatar } from './ui.js';
import { ctx } from './state.js';
import { renderLanding } from './pages/landing.js';
import { renderOnboarding } from './pages/onboarding.js';
import * as creator from './pages/creator.js';
import * as business from './pages/business.js';
import * as deals from './pages/deals.js';
import * as admin from './pages/admin.js';
import * as common from './pages/common.js';
import { auth } from './api.js';
import { skeleton, countUp, drawJourney } from './motion.js';
import { icon } from './icons.js';

const NAV = {
  creator: [
    ['#/home', 'Home', 'home'], ['#/deals', 'Deals', 'deals'], ['#/profile', 'My profile', 'user'], ['#/earnings', 'Earnings', 'wallet'], ['#/notifications', 'Notifications', 'bell'],
  ],
  business: [
    ['#/home', 'Dashboard', 'home'], ['#/discover', 'Find creators', 'search'], ['#/campaigns', 'Campaigns', 'megaphone'], ['#/deals', 'Deals', 'deals'],
    ['#/payments', 'Payments', 'card'], ['#/company', 'Company profile', 'building'], ['#/notifications', 'Notifications', 'bell'],
  ],
  admin: [
    ['#/admin', 'Overview', 'chart'], ['#/admin/disputes', 'Disputes', 'alert'], ['#/admin/creators', 'Creators', 'user'], ['#/admin/businesses', 'Businesses', 'building'],
    ['#/admin/users', 'Users', 'users'], ['#/admin/deals', 'Deals', 'deals'], ['#/admin/payments', 'Payments', 'card'], ['#/admin/audit', 'Audit log', 'log'],
    ['#/notifications', 'Notifications', 'bell'],
  ],
};

// [pattern, handler] — first match wins
const ROUTES = [
  [/^#\/deals\/(\d+)$/, (m) => deals.dealPage(m[1])],
  [/^#\/deals(?:\?.*)?$/, () => deals.dealList()],
  [/^#\/notifications$/, () => common.notifications()],
  // creator
  [/^#\/home$/, () => (ctx.role === 'creator' ? creator.home() : ctx.role === 'business' ? business.home() : admin.overview())],
  [/^#\/profile(?:\/(\w+))?$/, (m) => creator.profile(m[1] || 'details')],
  [/^#\/earnings$/, () => creator.earnings()],
  // business
  [/^#\/discover$/, () => business.discover()],
  [/^#\/creators\/(\d+)(?:\?.*)?$/, (m) => business.creatorProfile(m[1])],
  [/^#\/campaigns$/, () => business.campaigns()],
  [/^#\/campaigns\/new$/, () => business.campaignForm()],
  [/^#\/campaigns\/(\d+)\/edit$/, (m) => business.campaignForm(m[1])],
  [/^#\/campaigns\/(\d+)$/, (m) => business.campaignPage(m[1])],
  [/^#\/payments$/, () => business.payments()],
  [/^#\/company$/, () => business.company()],
  // admin
  [/^#\/admin$/, () => admin.overview()],
  [/^#\/admin\/disputes\/(\d+)$/, (m) => admin.disputePage(m[1])],
  [/^#\/admin\/(disputes|creators|businesses|users|deals|payments|audit)$/, (m) => admin.list(m[1])],
];

async function boot() {
  try {
    ctx.me = await get('/me');
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 && /sign in/i.test(e.message))) return renderLanding();
    const hint = e.status === 404
      ? 'The Brandfluence server isn\'t responding at /server/brandfluence_api. The backend function may not be deployed yet.'
      : e.message;
    $('#app').innerHTML = `<div class="onboard"><h1>We couldn't reach Brandfluence</h1><p>${esc(hint)}</p><p class="small muted">Error ${esc(e.status || '')}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  if (!ctx.me.onboarded) return renderOnboarding();
  ctx.role = ctx.me.profile.role;
  try { ctx.meta = await get('/meta/options'); } catch { ctx.meta = {}; }
  shell();
  window.addEventListener('hashchange', route);
  if (!location.hash || location.hash === '#/' || location.hash === '#') location.hash = ctx.role === 'admin' ? '#/admin' : '#/home';
  else route();
  refreshUnread();
  setInterval(refreshUnread, 60000);
}

function shell() {
  const name = ctx.role === 'creator' ? ctx.me.creator.full_name : ctx.role === 'business' ? ctx.me.business.company_name : ctx.me.user.email;
  $('#app').innerHTML = `
    <div class="topbar"><a class="brand" href="#/home"><i></i>Brandfluence</a><button id="menu-btn" aria-controls="side" aria-expanded="false">Menu</button></div>
    <div class="shell">
      <aside class="side" id="side">
        <a class="brand" href="${ctx.role === 'admin' ? '#/admin' : '#/home'}"><i></i>Brandfluence</a>
        <nav class="nav" aria-label="Main">${NAV[ctx.role].map(([h, t, ic]) => `<a href="${h}" data-nav="${h}">${icon(ic)}<span>${esc(t)}</span>${h === '#/notifications' ? '<span class="count hidden" id="unread"></span>' : ''}</a>`).join('')}</nav>
        <div class="side-foot">${avatar(name, ctx.role === 'creator' ? ctx.me.creator.photo_url : ctx.role === 'business' ? ctx.me.business.logo_url : null, 'sm')}<div style="min-width:0"><div class="who">${esc(name)}</div><div class="small" style="color:#9C91B2">${esc(ctx.role === 'admin' ? 'Administrator' : ctx.role === 'creator' ? 'Creator' : 'Business')}</div><button id="logout">${icon('logout', 14)} Sign out</button></div></div>
      </aside>
      <main class="main" id="main" tabindex="-1"></main>
    </div>`;
  $('#logout').onclick = () => auth.logout();
  $('#menu-btn').onclick = () => { const s = $('#side'); s.classList.toggle('open'); $('#menu-btn').setAttribute('aria-expanded', s.classList.contains('open')); };
}

async function route() {
  const hash = location.hash || '#/home';
  $('#side') && $('#side').classList.remove('open');
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const h = a.getAttribute('data-nav');
    a.classList.toggle('active', hash === h || (h !== '#/admin' && hash.startsWith(h + '/')));
  });
  const main = $('#main');
  main.classList.remove('enter');
  main.innerHTML = skeleton();
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(m);
        main.classList.add('enter');
        countUp(main);
        drawJourney(main.querySelector('.journey'));
      } catch (e) { main.innerHTML = `<div class="panel"><h2>This page couldn't load</h2><p>${esc(e.message)}</p><a class="btn secondary" href="#/home">Go to home</a></div>`; fail(e); }
      main.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      return;
    }
  }
  main.innerHTML = `<div class="panel"><h2>Page not found</h2><a class="btn secondary" href="#/home">Go to home</a></div>`;
}

export async function refreshUnread() {
  try {
    const { unread } = await get('/notifications?size=1');
    ctx.unread = unread;
    const el = document.getElementById('unread');
    if (el) { el.textContent = unread; el.classList.toggle('hidden', !unread); }
  } catch { /* ignore */ }
}

boot();
