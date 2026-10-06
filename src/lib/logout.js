import { supabase } from './supabaseClient';
import { invokeAppAuth } from './appAuth';
import { clearAppSession, getAppSession } from './appSession';

export async function secureLogout(redirectUrl) {
  try {
    if (getAppSession()) await invokeAppAuth('logout');
  } catch { /* Local logout still proceeds if backend revocation is unavailable. */ }
  finally {
    clearAppSession();
    await supabase.auth.signOut({ scope: 'local' });
  }
  if (redirectUrl) window.location.assign(redirectUrl);
}
