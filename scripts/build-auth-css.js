#!/usr/bin/env node
/**
 * Builds client/css/embedded-auth.css for the Catalyst sign-in form:
 *   Catalyst's official template stylesheet  +  our overrides (client/css/embedded-brand.css)
 * Catalyst's docs say to add custom styles after the template's last line.
 * If the template can't be downloaded, nothing is written and the sign-in form keeps Catalyst's default look.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'client', 'css', 'embedded-auth.css');
const brand = path.join(root, 'client', 'css', 'embedded-brand.css');
const URLS = (process.env.AUTH_CSS_URL ? [process.env.AUTH_CSS_URL] : [
  'https://api.catalyst.zoho.com/baas/v1/auth/static-file?file_name=embedded_signin.css',
  'https://api.catalyst.zoho.in/baas/v1/auth/static-file?file_name=embedded_signin.css',
]);

(async () => {
  for (const url of URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      // must look like a real stylesheet, not an error page
      if (!res.ok || text.length < 5000 || /<html/i.test(text.slice(0, 500)) || !/\{[^}]*\}/.test(text)) {
        console.warn(`build-auth-css: ${url} did not return the template (status ${res.status}, ${text.length} bytes)`);
        continue;
      }
      fs.writeFileSync(out, text.replace(/^﻿/, '') + '\n\n' + fs.readFileSync(brand, 'utf8'));
      console.log(`build-auth-css: wrote client/css/embedded-auth.css (${text.length} bytes template + brand overrides)`);
      return;
    } catch (e) {
      console.warn(`build-auth-css: could not download ${url}: ${e.message}`);
    }
  }
  console.warn('build-auth-css: template not available, sign-in form will use Catalyst\'s default look');
})();
