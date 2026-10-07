import { supabase } from './supabaseClient';

export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function readRows(createQuery, signal) {
  const rows = [];
  while (!signal.aborted) {
    const { data, error, count } = await createQuery().range(rows.length, rows.length + 499).abortSignal(signal);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (count !== null && rows.length >= count) break;
  }
  return rows;
}

export async function readPartners(signal, id) {
  const query = () => {
    let query = supabase.from('organizations').select('id,name,is_active', { count: 'exact' }).eq('type', 'partner');
    if (id) query = query.eq('id', id);
    return query.order('name').order('id');
  };
  const organizations = await readRows(query, signal);
  const details = [];
  for (let offset = 0; offset < organizations.length; offset += 100) {
    const { data, error } = await supabase.from('partner_details')
      .select('organization_id,partner_type,contact_name,contact_email,contact_phone,description')
      .in('organization_id', organizations.slice(offset, offset + 100).map(row => row.id)).abortSignal(signal);
    if (error) throw error;
    details.push(...data);
  }
  return organizations.map(row => {
    const detail = details.find(detail => detail.organization_id === row.id);
    return { ...row, ...detail, type: detail?.partner_type || 'other' };
  });
}
