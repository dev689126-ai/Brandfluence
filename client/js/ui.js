// Small UI toolkit: escaping, formatting, toasts, modals, form helpers
import { fileUrl } from './api.js';
import { leave } from './motion.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const inr = (n) => (n === null || n === undefined || n === '') ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e7) return (n / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
export const pct = (n) => (n === null || n === undefined || n === '') ? '—' : Number(n).toFixed(1) + '%';
const NAMES = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', x: 'X', linkedin: 'LinkedIn', twitch: 'Twitch' };
export const label = (s) => NAMES[s] || String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export function date(s, withTime) {
  if (!s) return '—';
  const d = new Date(String(s).replace(' ', 'T').slice(0, 19));
  if (isNaN(d)) return esc(s);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
export const isTrue = (v) => v === true || v === 'true';
export const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export function avatar(name, key, cls = '') {
  const id = 'av' + Math.random().toString(36).slice(2, 9);
  if (key) fileUrl(key).then((u) => { const el = document.getElementById(id); if (el && u) el.innerHTML = `<img src="${esc(u)}" alt="">`; }).catch(() => {});
  return `<span class="avatar ${cls}" id="${id}" aria-hidden="true">${esc(initials(name))}</span>`;
}

/* Status tags with consistent colours across the app */
const TAG = {
  offer_sent: 'gold', negotiation: 'gold', accepted: 'teal', contract_signed: 'teal', payment_secured: 'teal',
  in_progress: 'teal', content_submitted: 'gold', revision_requested: 'gold', approved: 'green', published: 'green',
  completed: 'green', rejected: '', cancelled: '', disputed: 'rose',
  held: 'gold', released: 'green', created: '', refunded: 'rose', partially_refunded: 'rose',
  open: 'rose', under_review: 'gold', resolved: 'green',
  verified: 'green', submitted: 'gold', pending: '', active: 'green', suspended: 'rose', draft: '', paused: 'gold',
  approved_sub: 'green', changes_requested: 'gold',
};
const NICE = { offer_sent: 'Offer sent', content_submitted: 'Content in review', revision_requested: 'Changes requested',
  payment_secured: 'Payment secured', contract_signed: 'Agreement signed', in_progress: 'Creating content', held: 'Held safely' };
export const tag = (s) => `<span class="tag ${TAG[s] || ''}">${esc(NICE[s] || label(s))}</span>`;

/* Toasts */
export function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => leave(el, 'leaving', 220), type === 'error' ? 6000 : 3500);
}
export const fail = (e) => toast(e && e.message ? e.message : 'Something went wrong', 'error');

/* Modal: returns { el, close } */
export function modal(title, html, { wide } = {}) {
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-back';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${wide ? 'style="width:min(820px,100%)"' : ''}>
    <div class="modal-head"><h2>${esc(title)}</h2><button class="x" aria-label="Close">×</button></div>${html}</div>`;
  root.appendChild(wrap);
  const close = () => { leave(wrap, 'leaving', 180); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  $('.x', wrap).onclick = close;
  const first = $('input, select, textarea, button:not(.x)', wrap);
  if (first) first.focus();
  return { el: wrap, close };
}

export function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const m = modal(title, `<p>${esc(text)}</p><div class="btn-row"><button class="btn ${danger ? 'danger' : ''}" data-ok>${esc(okLabel)}</button><button class="btn secondary" data-no>Go back</button></div>`);
    $('[data-ok]', m.el).onclick = () => { m.close(); resolve(true); };
    $('[data-no]', m.el).onclick = () => { m.close(); resolve(false); };
  });
}

/* Forms */
export function formData(form) {
  const out = {};
  new FormData(form).forEach((v, k) => {
    if (k.endsWith('[]')) { const kk = k.slice(0, -2); (out[kk] = out[kk] || []).push(v); }
    else out[k] = typeof v === 'string' ? v.trim() : v;
  });
  $$('input[type=checkbox][data-bool]', form).forEach((c) => { out[c.name] = c.checked; });
  return out;
}

// Disable a button while an async action runs; shows errors as toasts
export function busy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Working…';
    try { return await fn(...args); }
    catch (e) { fail(e); }
    finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
  };
}

export function field(name, text, { type = 'text', value = '', hint = '', required = false, attrs = '' } = {}) {
  const input = type === 'textarea'
    ? `<textarea name="${name}" ${required ? 'required' : ''} ${attrs}>${esc(value)}</textarea>`
    : `<input type="${type}" name="${name}" value="${esc(value)}" ${required ? 'required' : ''} ${attrs}>`;
  return `<label class="field"><span>${esc(text)}</span>${input}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}
export function select(name, text, options, value = '', { hint = '', blank = '' } = {}) {
  const opts = options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, label(o)]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('');
  return `<label class="field"><span>${esc(text)}</span><select name="${name}">${blank ? `<option value="">${esc(blank)}</option>` : ''}${opts}</select>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}
export function chips(name, options, selected = []) {
  const sel = new Set((Array.isArray(selected) ? selected : String(selected || '').split(',')).map((s) => s.trim()).filter(Boolean));
  return `<div class="chips">${options.map((o) => `<label class="chip"><input type="checkbox" name="${name}[]" value="${esc(o)}" ${sel.has(o) ? 'checked' : ''}>${esc(o)}</label>`).join('')}</div>`;
}

export const emptyState = (text, action = '') => `<div class="empty"><p>${esc(text)}</p>${action}</div>`;
