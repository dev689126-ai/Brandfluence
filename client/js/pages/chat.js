// Direct chats between creators and businesses (pitches before any deal)
import { get, post } from '../api.js';
import { $, esc, date, compact, toast, fail, modal, busy, field, emptyState, avatar, confirmBox } from '../ui.js';
import { ctx, go } from '../state.js';
import { icon } from '../icons.js';

const main = () => $('#main');
let poll = null;
const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/messages/')) stopPoll(); });

const STATUS = { open: '', converted: '<span class="tag green">Offer sent</span>', closed: '<span class="tag">Closed</span>' };

/* ---------------- Inbox ---------------- */
export async function inbox() {
  stopPoll();
  const r = await get('/conversations');
  const isCreator = ctx.role === 'creator';
  const p = r.plan;
  main().innerHTML = `
    <div class="page-head"><div><h1>Messages</h1><p>${isCreator ? 'Talk to brands before any deal. When it fits, the brand sends you an offer.' : 'Chats with creators, including pitches from creators who want to work with you.'}</p></div>
      ${isCreator ? '<a class="btn" href="#/brands">Find brands to pitch</a>' : '<a class="btn" href="#/discover">Find creators</a>'}</div>
    ${isCreator && p ? pitchBar(p) : ''}
    ${r.data.length ? `<div class="rows">${r.data.map((c) => `<a class="row" href="#/messages/${c.ROWID}">
        <div style="display:flex;gap:12px;align-items:center;min-width:0">${avatar(c.with ? c.with.name : '?', c.with && c.with.photo)}
          <div style="min-width:0"><div class="t">${esc(c.with ? c.with.name : 'Unknown')} ${c.with && c.with.is_pro ? proBadge() : ''} ${c.started_by === 'creator' && !isCreator ? '<span class="tag gold">Pitch</span>' : ''} ${STATUS[c.status] || ''}</div>
          <div class="s" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52ch">${c.subject ? `<b>${esc(c.subject)}</b> · ` : ''}${esc(c.last_message || '')}</div></div></div>
        <div style="text-align:right" class="nowrap"><div class="small muted">${date(c.last_message_at || c.CREATEDTIME)}</div>${c.unread ? `<span class="tag rose">${c.unread} new</span>` : ''}</div></a>`).join('')}</div>`
      : `<div class="rows">${emptyState(isCreator ? 'No chats yet. Find a brand you like and send a short pitch.' : 'No chats yet. Creators who pitch you will show up here.', isCreator ? '<a class="btn" href="#/brands">Find brands</a>' : '')}</div>`}`;
}

export const proBadge = () => '<span class="tag pro" title="Pro creator">PRO</span>';

export function pitchBar(p) {
  return `<div class="panel pitch-bar"><div><b>${p.pitches.left}</b> of ${p.pitches.limit} pitch${p.pitches.limit === 1 ? '' : 'es'} left this month
    <div class="small muted">${p.is_pro ? `Pro until ${date(p.expires_at)}` : 'Free plan. Replying to brands is always free.'}</div></div>
    ${p.is_pro ? '' : '<a class="btn money small" href="#/plan">Upgrade to Pro</a>'}</div>`;
}

/* ---------------- One chat ---------------- */
export async function thread(id) {
  stopPoll();
  const r = await get('/conversations/' + id);
  const c = r.conversation;
  const w = r.with || {};
  const isCreator = ctx.role === 'creator';
  const profileLink = isCreator ? `#/brands/${c.business_id}` : `#/creators/${c.creator_id}`;
  main().innerHTML = `
    <div class="page-head"><div style="display:flex;gap:14px;align-items:center">${avatar(w.name, w.photo, 'lg')}
      <div><h1 style="margin:0">${esc(w.name || 'Chat')} ${w.is_pro ? proBadge() : ''}</h1>
      <p style="margin:2px 0 0">${c.subject ? esc(c.subject) + ' · ' : ''}${isCreator ? esc([w.category, w.city].filter(Boolean).join(' · ')) : `@${esc(w.username || '')}${w.followers ? ` · ${compact(w.followers)} followers` : ''}`}</p></div></div>
      <div class="btn-row"><a class="btn secondary" href="${profileLink}">${isCreator ? 'View brand' : 'View profile'}</a>
        ${!isCreator && c.status !== 'closed' ? `<a class="btn money" href="#/creators/${c.creator_id}?offer=1&conv=${c.ROWID}">${icon('rupee', 16)} Send offer</a>` : ''}
        ${c.deal_id ? `<a class="btn" href="#/deals/${c.deal_id}">Open deal</a>` : ''}
        ${c.status !== 'closed' ? '<button class="btn ghost" id="close-chat">Close chat</button>' : ''}</div></div>
    <div class="panel">
      <div class="chat" id="chat"><div class="chat-log" id="log"></div>
      ${c.status === 'closed' ? '<p class="small muted" style="text-align:center">This chat is closed.</p>' : `<form class="chat-form" id="cf"><textarea name="body" maxlength="2000" placeholder="Write a message" aria-label="Message"></textarea><button class="btn" type="submit">Send</button></form>`}</div>
      <p class="small muted" style="margin:10px 0 0">${icon('shield', 14)} Keep deals and payments on Brandfluence: your money is only protected when the offer, agreement and payment happen here.</p>
    </div>`;
  const log = $('#log');
  let lastId = null;
  const render = (msgs, append) => {
    if (!append && !msgs.length) log.innerHTML = '<div class="msg system">No messages yet.</div>';
    msgs.forEach((m) => {
      const el = document.createElement('div');
      el.className = 'msg' + (m.mine ? ' mine' : '') + (append ? ' arrive' : '');
      el.innerHTML = `${esc(m.body)}<span class="meta">${m.mine ? 'You' : esc(w.name || '')} · ${date(m.CREATEDTIME, true)}</span>`;
      log.appendChild(el);
      lastId = m.ROWID;
    });
    log.scrollTop = log.scrollHeight;
  };
  render(r.messages, false);
  if (c.status === 'converted' && !isCreator) log.insertAdjacentHTML('beforeend', '<div class="msg system">You sent an offer from this chat.</div>');

  const f = $('#cf');
  if (f) {
    const send = busy($('button[type=submit]', f), async () => {
      const body = f.body.value.trim();
      if (!body) return;
      const m = await post(`/conversations/${id}/messages`, { body });
      f.body.value = '';
      if (!lastId) log.innerHTML = '';
      render([m], true);
    });
    f.onsubmit = (e) => { e.preventDefault(); send(); };
    f.body.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  }
  const closeBtn = $('#close-chat');
  if (closeBtn) closeBtn.onclick = async () => {
    if (!(await confirmBox('Close this chat?', 'Neither of you can send more messages here. You can still start a new chat later.', 'Close chat'))) return;
    try { await post(`/conversations/${id}/close`); toast('Chat closed'); go('#/messages'); } catch (e) { fail(e); }
  };
  // Check for new messages every 10 seconds while this chat is open
  poll = setInterval(async () => {
    if (document.hidden || !document.getElementById('log')) return;
    try {
      const n = await get(`/conversations/${id}${lastId ? `?after=${lastId}` : ''}`);
      if (n.messages.length) render(n.messages, true);
    } catch { /* ignore */ }
  }, 10000);
}

/* ---------------- Start a chat (used from profiles) ---------------- */
export function startChatModal({ to, name, subjectHint = '', onUpgrade }) {
  const isCreator = ctx.role === 'creator';
  const m = modal(isCreator ? `Pitch ${name}` : `Message ${name}`, `<form id="sc">
    ${field('subject', isCreator ? 'What are you offering?' : 'Subject', { value: subjectHint, attrs: `maxlength="200" placeholder="${isCreator ? 'e.g. 2 food reels for your Diwali menu' : 'e.g. Collaboration for our launch'}"` })}
    ${field('body', 'Message', { type: 'textarea', required: true, attrs: 'maxlength="2000" rows="6"', hint: isCreator ? 'Say who you are, why your audience fits this brand, and what you would create. Short and specific works best.' : 'Introduce your brand and what you have in mind.' })}
    <button class="btn" type="submit">${isCreator ? 'Send pitch' : 'Send message'}</button></form>`);
  const f = $('#sc', m.el);
  const send = busy($('button[type=submit]', f), async () => {
    try {
      const r = await post('/conversations', { ...to, subject: f.subject.value, body: f.body.value });
      m.close();
      toast(r.existing ? 'Added to your existing chat' : isCreator ? 'Pitch sent' : 'Message sent');
      go('#/messages/' + r.conversation.ROWID);
    } catch (e) {
      if (e.status === 402) { m.close(); (onUpgrade || upgradePrompt)(e.message); return; }
      throw e;
    }
  });
  f.onsubmit = (e) => { e.preventDefault(); send(); };
}

export function upgradePrompt(message) {
  const m = modal('Upgrade to Pro', `<p>${esc(message)}</p><div class="btn-row"><a class="btn money" href="#/plan" data-go>See Pro plan</a><button class="btn secondary" data-no>Not now</button></div>`);
  $('[data-go]', m.el).onclick = () => m.close();
  $('[data-no]', m.el).onclick = () => m.close();
}

