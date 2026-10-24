export const TOKENS = globalThis.__TOKENS ||= {};
export const CLAIMS = globalThis.__CLAIMS ||= {};
export const getAuth = () => ({
  async verifyIdToken(t) { const v = TOKENS[t]; if (!v) throw new Error('bad token'); return { ...v }; },
  async getUserByEmail(e) { const u = Object.values(TOKENS).find(x => x.email === e); if (!u) throw Object.assign(new Error('nf'), { code: 'auth/user-not-found' }); return { uid: u.uid, customClaims: CLAIMS[u.uid] || {} }; },
  async setCustomUserClaims(uid, c) { CLAIMS[uid] = c; },
  async revokeRefreshTokens() {},
  async deleteUser(uid) { const k = Object.keys(TOKENS).find(t => TOKENS[t].uid === uid); if (!k) throw Object.assign(new Error('nf'), { code: 'auth/user-not-found' }); delete TOKENS[k]; (globalThis.__DELETED ||= []).push(uid); }
});
