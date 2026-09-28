// Shared session state
export const ctx = { me: null, role: null, meta: null, unread: 0 };
export const go = (hash) => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };
