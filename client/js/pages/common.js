import { get, post } from '../api.js';
import { $, $$, esc, date, emptyState, fail } from '../ui.js';
import { go } from '../state.js';
import { refreshUnread } from '../app.js';

export async function notifications() {
  const { data, unread } = await get('/notifications?size=50');
  $('#main').innerHTML = `
    <div class="page-head"><div><h1>Notifications</h1><p>${unread ? `${unread} unread` : 'You\'re all caught up.'}</p></div>${unread ? '<button class="btn secondary" id="all">Mark all as read</button>' : ''}</div>
    ${data.length ? `<div class="rows">${data.map((n) => `<a class="row" href="#${esc(n.link || '/home')}" data-id="${n.ROWID}" style="${String(n.is_read) === 'true' ? '' : 'box-shadow:inset 3px 0 0 var(--marigold)'}">
      <div><div class="t">${esc(n.title)}</div>${n.body ? `<div class="s">${esc(n.body)}</div>` : ''}</div><span class="small muted nowrap">${date(n.CREATEDTIME, true)}</span></a>`).join('')}</div>`
      : `<div class="rows">${emptyState('No notifications yet. Offers, messages and payment updates will show up here.')}</div>`}`;
  const all = $('#all');
  if (all) all.onclick = async () => { try { await post('/notifications/read-all'); refreshUnread(); go('#/notifications'); } catch (e) { fail(e); } };
  $$('[data-id]').forEach((a) => { a.addEventListener('click', () => { post(`/notifications/${a.dataset.id}/read`).then(refreshUnread).catch(() => {}); }); });
}
