// Brandfluence motion: small, purposeful, and off when the user prefers reduced motion.
export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Page change: one quiet crossfade of the main area (View Transitions API when available) */
export function swap(el, render) {
  if (reduced() || !document.startViewTransition) return render();
  return document.startViewTransition(render).updateCallbackDone;
}

/* Skeleton shown while a page loads — shaped like the page it replaces */
export function skeleton(kind = 'page') {
  const bar = (w, h = 14, extra = '') => `<span class="sk" style="width:${w};height:${h}px;${extra}"></span>`;
  const rows = Array.from({ length: 4 }, () => `<div class="sk-row">${bar('42%')}${bar('18%', 22, 'border-radius:999px')}</div>`).join('');
  return `<div class="sk-wrap" aria-busy="true" aria-label="Loading">
    ${bar('34%', 30)}${bar('52%', 14, 'margin-top:10px')}
    <div class="sk-figs">${Array.from({ length: 4 }, () => `<div>${bar('60%', 26)}${bar('40%', 12, 'margin-top:8px')}</div>`).join('')}</div>
    ${kind === 'page' ? `<div class="sk-rows">${rows}</div>` : ''}
  </div>`;
}

/* Count figures up from 0 to their value. Works on any element with data-count="1234.5" and data-fmt */
export function countUp(root = document) {
  // Auto-detect figures rendered as text: ₹1,85,000 · 2.5L · 6.9% · 12
  root.querySelectorAll('.figure b:not([data-count])').forEach((el) => {
    const t = el.textContent.trim();
    let m;
    if ((m = t.match(/^₹([\d,]+(?:\.\d+)?)$/))) { el.dataset.count = m[1].replace(/,/g, ''); el.dataset.fmt = 'inr'; }
    else if ((m = t.match(/^([\d.]+)%$/))) { el.dataset.count = m[1]; el.dataset.fmt = 'pct'; }
    else if ((m = t.match(/^([\d.]+)(K|L|Cr)$/))) { el.dataset.count = Number(m[1]) * { K: 1e3, L: 1e5, Cr: 1e7 }[m[2]]; el.dataset.fmt = 'compact'; }
    else if (/^\d[\d,]*$/.test(t)) { el.dataset.count = t.replace(/,/g, ''); el.dataset.fmt = 'plain'; }
  });
  root.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const fmt = FORMATS[el.dataset.fmt || 'plain'];
    if (!Number.isFinite(target) || reduced() || target === 0) { el.textContent = fmt(target || 0); return; }
    const start = performance.now();
    const dur = 900;
    const tick = (t) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = fmt(target * eased, p < 1);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const compact = (n) => {
  n = Number(n) || 0;
  if (n >= 1e7) return (n / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
};
const FORMATS = {
  plain: (n) => Math.round(n).toLocaleString('en-IN'),
  inr: (n, moving) => '₹' + (moving ? Math.round(n) : n).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
  compact: (n) => compact(n),
  pct: (n) => n.toFixed(1) + '%',
};

/* Signature moment: the deal track draws itself stop by stop up to where the deal is now */
export function drawJourney(rail) {
  if (!rail) return;
  const stops = [...rail.querySelectorAll('.stop')];
  if (reduced()) { stops.forEach((s) => s.classList.add('shown')); return; }
  rail.classList.add('drawing');
  const lastDone = stops.findIndex((s) => s.classList.contains('now'));
  const upTo = lastDone === -1 ? stops.length - 1 : lastDone;
  stops.forEach((s, i) => {
    const delay = i <= upTo ? i * 110 : upTo * 110 + 80;
    setTimeout(() => s.classList.add('shown'), delay);
  });
  setTimeout(() => rail.classList.remove('drawing'), upTo * 110 + 500);
}

/* Landing page: a demo deal that plays through its life on a loop */
export function playDemo(rail, statusEl, lines) {
  const stops = [...rail.querySelectorAll('.stop')];
  const labels = ['Offer sent: ₹40,000, countered at ₹50,000', 'Both sides signed the agreement', '₹50,000 paid in and held safely', 'Brand approved 2 Reels + 3 Stories', '₹50,000 released to the creator'];
  let i = 0;
  const set = (n) => {
    stops.forEach((s, k) => { s.classList.toggle('done', k < n); s.classList.toggle('now', k === n); s.classList.add('shown'); });
    if (statusEl) { statusEl.classList.remove('flip'); void statusEl.offsetWidth; statusEl.textContent = labels[Math.min(n, labels.length - 1)]; statusEl.classList.add('flip'); }
    if (lines) lines.classList.toggle('paid', n >= stops.length - 1);
  };
  if (reduced()) { set(3); return () => {}; }
  set(0);
  const id = setInterval(() => { i = (i + 1) % (stops.length + 1); set(Math.min(i, stops.length - 1)); }, 1600);
  return () => clearInterval(id);
}

/* Animate an element out, then remove it */
export function leave(el, cls = 'leaving', ms = 180) {
  if (reduced()) { el.remove(); return; }
  el.classList.add(cls);
  setTimeout(() => el.remove(), ms);
}
