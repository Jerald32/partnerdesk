import { createClient } from 'npm:@supabase/supabase-js@2.95.0';
import nodemailer from 'npm:nodemailer@7.0.11';
import { createWorker } from './worker.mjs';

const env = (name: string) => Deno.env.get(name) ?? '';
const configured = () => ['INACTIVITY_CRON_SECRET','INACTIVITY_SMTP_HOST','INACTIVITY_SMTP_PORT',
  'INACTIVITY_SMTP_USER','INACTIVITY_SMTP_PASSWORD','INACTIVITY_SMTP_FROM','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].every(name => Boolean(env(name)));
const transport = nodemailer.createTransport({ host: env('INACTIVITY_SMTP_HOST'), port: Number(env('INACTIVITY_SMTP_PORT')),
  secure: env('INACTIVITY_SMTP_PORT') === '465', requireTLS: env('INACTIVITY_SMTP_PORT') !== '465',
  auth: { user: env('INACTIVITY_SMTP_USER'), pass: env('INACTIVITY_SMTP_PASSWORD') },
  connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
Deno.serve(createWorker({
  async ready() {
    if (!configured()) return false;
    try { await transport.verify(); return true; } catch (error) {
      const smtpError = error as { code?: string };
      const code = typeof smtpError?.code === 'string' && ['EAUTH','ECONNECTION','ETIMEDOUT','ESOCKET','ENOTFOUND','EPROTOCOL'].includes(smtpError.code) ? smtpError.code : 'unavailable';
      return `smtp_${code}`;
    }
  },
  async authorize(header: string | null) {
    const secret = env('INACTIVITY_CRON_SECRET');
    if (!secret || !header || header.length > 512) return false;
    const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    const [expected, actual] = await Promise.all([digest(`Bearer ${secret}`), digest(header)]);
    return expected.reduce((diff, byte, index) => diff | (byte ^ actual[index]), 0) === 0;
  },
  async rpc(name: string, args: Record<string, unknown>) {
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new Error('database_unavailable');
    return data;
  },
  async send(item: { id: string; email: string; subject: string; text: string }) {
    const result = await transport.sendMail({ from: env('INACTIVITY_SMTP_FROM'), to: item.email,
      subject: item.subject, text: item.text, messageId: `<inactivity-${item.id}@partnerdesk.local>` });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('smtp_delivery_failed');
  },
}));
