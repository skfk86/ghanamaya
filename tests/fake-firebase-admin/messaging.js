export const SENT = globalThis.__SENT ||= [];
export const getMessaging = () => ({ async send(m) { SENT.push(m); return 'id'; } });
