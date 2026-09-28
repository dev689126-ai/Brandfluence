'use strict';
/** Stratus helpers: presigned upload/download URLs and server-side writes. */

function bucket(app, name) {
  return app.stratus().bucket(name);
}

async function signedUrl(app, bucketName, key, method, expirySeconds = 900) {
  const res = await bucket(app, bucketName).generatePreSignedUrl(key, method, { expiryIn: expirySeconds });
  return (res && (res.signature || res.url)) || res;
}

async function putObject(app, bucketName, key, data, contentType) {
  return bucket(app, bucketName).putObject(key, data, contentType ? { contentType } : undefined);
}

async function getObject(app, bucketName, key) {
  return bucket(app, bucketName).getObject(key);
}

function safeName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
}

module.exports = { signedUrl, putObject, getObject, safeName };
