'use strict';
/**
 * Thin data-access layer over Catalyst Data Store + ZCQL.
 * All values interpolated into ZCQL MUST go through esc()/id()/num() to prevent injection.
 */
const { badRequest, notFound } = require('./errors');

const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''");
const str = (v) => `'${esc(v)}'`;

function id(v, name = 'id') {
  const s = String(v ?? '');
  if (!/^\d{1,19}$/.test(s)) throw badRequest(`Invalid ${name}`);
  return s;
}
function num(v, name = 'number') {
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`Invalid ${name}`);
  return n;
}
function list(values, fn = str) {
  if (!values.length) return '(NULL)';
  return `(${values.map(fn).join(',')})`;
}

async function query(app, sql) {
  const res = await app.zcql().executeZCQLQuery(sql);
  return res || [];
}

// ZCQL returns [{ TableName: {...} }] — unwrap to plain objects
async function select(app, table, where = '', tail = '') {
  const sql = `SELECT * FROM ${table}${where ? ' WHERE ' + where : ''}${tail ? ' ' + tail : ''}`;
  const rows = await query(app, sql);
  return rows.map((r) => r[table]);
}

async function one(app, table, where) {
  const rows = await select(app, table, where, 'LIMIT 1');
  return rows[0] || null;
}

async function mustGet(app, table, rowId, label) {
  const row = await one(app, table, `ROWID = ${id(rowId)}`);
  if (!row) throw notFound(`${label || table} not found`);
  return row;
}

async function count(app, table, where = '') {
  const rows = await query(app, `SELECT COUNT(ROWID) FROM ${table}${where ? ' WHERE ' + where : ''}`);
  const r = rows[0] && rows[0][table];
  return r ? Number(Object.values(r)[0]) || 0 : 0;
}

async function sum(app, table, column, where = '') {
  const rows = await query(app, `SELECT SUM(${column}) FROM ${table}${where ? ' WHERE ' + where : ''}`);
  const r = rows[0] && rows[0][table];
  return r ? Number(Object.values(r)[0]) || 0 : 0;
}

const insert = (app, table, row) => app.datastore().table(table).insertRow(clean(row));
const insertMany = (app, table, rows) => app.datastore().table(table).insertRows(rows.map(clean));
const update = (app, table, row) => app.datastore().table(table).updateRow(clean(row));
const remove = (app, table, rowId) => app.datastore().table(table).deleteRow(id(rowId));

// Drop undefined keys so we never overwrite columns unintentionally
function clean(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out;
}

// Pick only allowed keys from a request body
function pick(body, keys) {
  const out = {};
  for (const k of keys) if (body && body[k] !== undefined) out[k] = body[k];
  return out;
}

// Catalyst datetime format: yyyy-MM-dd HH:mm:ss
function now(offsetMs = 0) {
  const d = new Date(Date.now() + offsetMs + 5.5 * 3600 * 1000); // IST project timezone
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
const today = () => now().slice(0, 10);

function paging(req, max = 100) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(max, Math.max(1, parseInt(req.query.size, 10) || 20));
  return { page, size, offset: (page - 1) * size, tail: `LIMIT ${(page - 1) * size}, ${size}` };
}

module.exports = { esc, str, id, num, list, query, select, one, mustGet, count, sum, insert, insertMany, update, remove, pick, now, today, paging };
