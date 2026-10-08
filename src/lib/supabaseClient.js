import { createClient } from '@supabase/supabase-js';
import { clearAppSession, getAppSession } from './appSession';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

if (!supabaseUrl) {
  throw new Error('Missing VITE_SUPABASE_URL. Set it in .env.local or your deployment environment.');
}

if (!supabasePublishableKey) {
  throw new Error('Missing VITE_SUPABASE_PUBLISHABLE_KEY. Set the public publishable key in .env.local or your deployment environment.');
}

if (!supabasePublishableKey.startsWith('sb_publishable_')) {
  throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY must be a public sb_publishable_ key. Never use a secret or service_role key in the frontend.');
}

// Read the current token for each Data API request, including requests after login.
const authStorageKey = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;

export function clearPersistedAuth() {
  // Our explicitly configured SDK storage only; never clear unrelated app data.
  for (const key of Object.keys(localStorage)) {
    if (key === authStorageKey || key.startsWith(authStorageKey + '-')) localStorage.removeItem(key);
  }
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: { storageKey: authStorageKey },
  global: {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (url.origin === new URL(supabaseUrl).origin && url.pathname.startsWith('/rest/v1/')) {
        headers.delete('X-PartnerDesk-Session');
        const session = getAppSession();
        if (session) headers.set('X-PartnerDesk-Session', session.token);
      }
      return fetch(input, { ...init, headers });
    },
  },
});

// Subscribe at client creation, before React mounts, so a fast recovery callback
// cannot be lost before AuthProvider subscribes. This grants no app session.
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY' && session) {
    clearAppSession();
    sessionStorage.setItem('partnerdesk_recovery_user', session.user.id);
  }
  if (event === 'SIGNED_OUT') sessionStorage.removeItem('partnerdesk_recovery_user');
});
