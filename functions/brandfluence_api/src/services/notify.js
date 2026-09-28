'use strict';
const db = require('../lib/db');

/**
 * In-app notification + best-effort email.
 * profileId = UserProfiles.ROWID of the recipient.
 */
async function notify(app, profileId, { type, title, body, dealId, link, email = true }) {
  const channels = ['in_app'];
  try {
    if (email && process.env.MAIL_FROM) {
      const p = await db.one(app, 'UserProfiles', `ROWID = ${db.id(profileId)}`);
      if (p && p.email) {
        const url = link ? `${process.env.APP_URL || ''}${link}` : process.env.APP_URL;
        await app.email().sendMail({
          from_email: process.env.MAIL_FROM,
          to_email: [p.email],
          subject: `Brandfluence: ${title}`,
          content: `<p>${escapeHtml(body || title)}</p>${url ? `<p><a href="${url}">Open in Brandfluence</a></p>` : ''}`,
          html_mode: true,
        });
        channels.push('email');
      }
    }
  } catch (e) {
    console.error('email failed', e.message);
  }
  try {
    await db.insert(app, 'Notifications', {
      user_profile_id: String(profileId),
      type,
      title: String(title).slice(0, 150),
      body,
      deal_id: dealId ? String(dealId) : undefined,
      link,
      channels_sent: channels.join(','),
    });
  } catch (e) {
    console.error('notification insert failed', e.message);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { notify, escapeHtml };
