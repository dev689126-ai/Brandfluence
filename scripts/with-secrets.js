#!/usr/bin/env node
/**
 * Runs a command (e.g. `catalyst deploy ...`) with secrets from secrets.local.json
 * written into each function's catalyst-config.json, then restores the files.
 * The committed config files therefore never contain secrets.
 *
 * Usage: node scripts/with-secrets.js catalyst deploy -p 5666000000546001
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const secretsFile = path.join(root, 'secrets.local.json');
if (!fs.existsSync(secretsFile)) {
  console.error('secrets.local.json not found. Copy secrets.example.json to secrets.local.json and fill in your values.');
  process.exit(1);
}
const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
const backups = {};

for (const [fn, vars] of Object.entries(secrets)) {
  const p = path.join(root, 'functions', fn, 'catalyst-config.json');
  if (!fs.existsSync(p)) continue;
  const original = fs.readFileSync(p, 'utf8');
  backups[p] = original;
  const cfg = JSON.parse(original);
  const env = cfg.deployment.env_variables;
  for (const [k, v] of Object.entries(vars)) if (v !== '' && v != null) env[k] = String(v);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

let code = 1;
try {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) { console.error('Give a command to run, e.g. catalyst deploy -p <projectId>'); process.exit(1); }
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' });
  code = r.status == null ? 1 : r.status;
} finally {
  for (const [p, content] of Object.entries(backups)) fs.writeFileSync(p, content);
}
process.exit(code);
