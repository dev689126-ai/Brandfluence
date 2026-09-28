// Thin client for the brandfluence_api function (same domain → Catalyst session cookie is sent automatically)
export const BASE = '/server/brandfluence_api';

function csrfHeader() {
  const m = document.cookie.match(/(?:^|;\s*)ZD_CSRF_TOKEN=([^;]+)/);
  return m ? { 'X-ZCSRF-TOKEN': 'zd_csrparam=' + decodeURIComponent(m[1]) } : {};
}

export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: { Accept: 'application/json', ...csrfHeader() } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(BASE + path, opts); }
  catch { throw new ApiError(0, 'You appear to be offline. Check your connection and try again.'); }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data && data.message) || `Request failed (${res.status})`, data && data.details);
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

export function qs(obj) {
  const s = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') s.set(k, v); });
  const out = s.toString();
  return out ? '?' + out : '';
}

/* Uploads go through the API (same web address, so no storage CORS setup is needed) */
const MAX_MB = { image: 10, video: 50, pdf: 15 };
export async function upload(file, purpose, dealId) {
  const kind = file.type.startsWith('video') ? 'video' : file.type === 'application/pdf' ? 'pdf' : 'image';
  if (file.size > MAX_MB[kind] * 1024 * 1024) throw new ApiError(400, `File is too large. Maximum for ${kind === 'pdf' ? 'PDFs' : kind + 's'} is ${MAX_MB[kind]} MB.`);
  let res;
  try {
    res = await fetch(BASE + '/uploads/file' + qs({ purpose, filename: file.name, deal_id: dealId }), {
      method: 'POST', credentials: 'include', body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream', ...csrfHeader() },
    });
  } catch { throw new ApiError(0, 'Upload failed. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message || (res.status === 413 ? 'File is too large.' : 'Upload failed. Please try again.'));
  return data.key;
}

/* Files are read through the API too, so the URL works directly in <img> and <video> */
export async function fileUrl(key) {
  if (!key) return '';
  if (/^https?:\/\//.test(key)) return key;
  return BASE + '/uploads/file' + qs({ key });
}

/* Catalyst hosted authentication */
export const auth = {
  login() { location.href = '/app/login.html'; },
  signup() { location.href = '/app/login.html#signup'; },
  logout() {
    try { if (window.catalyst && window.catalyst.auth) return window.catalyst.auth.signOut('/'); } catch { /* fall through */ }
    location.href = '/__catalyst/auth/logout';
  },
};
