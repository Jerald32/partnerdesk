const STORAGE_KEY = 'partnerdesk_app_session';

export function getAppSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    return value && typeof value.authUserId === 'string' && /^[0-9a-f]{64}$/.test(value.token) ? value : null;
  } catch { return null; }
}

export function saveAppSession(authUserId, data) {
  if (!/^[0-9a-f]{64}$/.test(data.app_session_token || '') || !data.session_id || !Number.isFinite(Date.parse(data.expires_at))) {
    throw new Error('App session response is invalid.');
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ authUserId, token: data.app_session_token,
    sessionId: data.session_id, expiresAt: data.expires_at }));
}

export function clearAppSession() { sessionStorage.removeItem(STORAGE_KEY); }
