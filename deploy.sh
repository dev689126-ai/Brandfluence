#!/usr/bin/env bash
# Brandfluence - deploy to Catalyst (Development). Secrets come from secrets.local.json.
set -e
cd "$(dirname "$0")"
command -v catalyst >/dev/null || npm install -g zcatalyst-cli
[ -f secrets.local.json ] || { echo "Copy secrets.example.json to secrets.local.json and fill in your values."; exit 1; }
(cd functions/brandfluence_api && npm install --omit=dev)
(cd functions/bf_scheduler && npm install --omit=dev)
node scripts/build-auth-css.js
node scripts/with-secrets.js catalyst deploy -p 5666000000546001
echo "DEPLOYED: https://brandfluence-60027750675.development.catalystserverless.in/app/index.html"
