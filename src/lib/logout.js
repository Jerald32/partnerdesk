import { supabase, clearPersistedAuth } from './supabaseClient';
import { invokeAppAuth } from './appAuth';
import { clearAppSession, getAppSession } from './appSession';
import { queryClientInstance } from './query-client';

export async function secureLogout(redirectUrl) {
  try {
    if (getAppSession()) await invokeAppAuth('logout');
  } catch { /* Local logout still proceeds if backend revocation is unavailable. */ }
  finally {
    clearAppSession();
    sessionStorage.removeItem('partnerdesk_recovery_user');
    queryClientInstance.clear();
    // SDK clears local storage on remote revocation failure; retry also handles
    // a transient session-read/refresh error before SDK removal is reached.
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) { clearPersistedAuth(); await supabase.auth.signOut({ scope: 'local' }); }
    } catch { clearPersistedAuth(); /* No app credential remains; restore fails closed. */ }
  }
  if (redirectUrl) window.location.assign(redirectUrl);
}
