'use strict';
const db = require('../lib/db');

async function audit(app, { actor, entityType, entityId, action, from, to, details, ip }) {
  try {
    await db.insert(app, 'AuditLogs', {
      actor_profile_id: actor ? actor.ROWID : undefined,
      actor_role: actor ? actor.role : 'system',
      entity_type: entityType,
      entity_id: String(entityId),
      action,
      from_status: from,
      to_status: to,
      details_json: details ? JSON.stringify(details).slice(0, 9900) : undefined,
      ip_address: ip,
    });
  } catch (e) {
    console.error('audit failed', e.message); // never block the main action
  }
}
module.exports = { audit };
