// Đăng nhập Google bằng Google Identity Services (token client, chạy hoàn toàn trên trình duyệt).
import { CONFIG } from './config.js';
import { db } from './db.js';

let tokenClient = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Không tải được thư viện đăng nhập Google'));
    document.head.appendChild(s);
  });
}

export async function getToken() {
  const t = await db.get('kv', 'token');
  if (t && t.expiresAt > Date.now() + 30_000) return t.accessToken;
  return null;
}

export async function everSignedIn() {
  return Boolean(await db.get('kv', 'signedInOnce'));
}

export async function signIn() {
  await loadGis();
  const first = !(await everSignedIn());
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.clientId,
        scope: CONFIG.scopes,
        callback: () => {},
      });
    }
    tokenClient.callback = async (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...CONFIG.scopes.split(' '))) {
        return reject(new Error('Cần cấp đủ 2 quyền Google Drive để app hoạt động'));
      }
      await db.set('kv', 'token', {
        accessToken: resp.access_token,
        expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
      });
      await db.set('kv', 'signedInOnce', true);
      resolve(resp.access_token);
    };
    tokenClient.error_callback = (err) => reject(new Error(err?.type === 'popup_closed' ? 'Đã đóng cửa sổ đăng nhập' : 'Đăng nhập không thành công'));
    tokenClient.requestAccessToken({ prompt: first ? 'consent' : '' });
  });
}

export async function clearToken() {
  await db.del('kv', 'token');
}

export async function signOut() {
  const t = await getToken();
  try {
    if (t) {
      await loadGis();
      google.accounts.oauth2.revoke(t, () => {});
    }
  } catch { /* bỏ qua */ }
  await db.del('kv', 'token');
  await db.del('kv', 'signedInOnce');
}
