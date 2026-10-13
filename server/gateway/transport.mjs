export const TABLES=new Set(['profiles','organizations','partner_details','businesses','service_partners','tickets','activities','ticket_attachments','notifications','role_requests','privacy_consents','system_settings','ip_whitelist']);
export const RPCS=new Set(['touch_app_session','get_my_consent_requirements','get_privacy_consent_status','list_signup_consent_policies','record_policy_consent','withdraw_policy_consent','list_role_request_organizations','submit_role_request','approve_role_request','reject_role_request','change_profile_role_organization','deactivate_profile','reactivate_profile','update_my_profile','create_business','update_business','create_partner','update_partner','link_service_partner','unlink_service_partner','change_service_partner_access_level','update_service_partner_terms','create_ticket','change_ticket_status','add_ticket_activity','change_ticket_assignment','change_ticket_operator','update_ticket_address','mark_notifications_read','read_admin_audit','search_admin_access_audit','read_ticket_detail_audited','read_lifecycle_review','set_dormancy_review_days','review_ticket_retention','read_ip_policy','save_ip_entry','confirm_ip_recovery_path','acknowledge_ip_operator_recovery','request_ip_activation','confirm_ip_transition']);
const ID=/^[a-z_][a-z0-9_]*$/;
export function selectFields(input){
 if(typeof input!=='string'||input.length>4000)throw new Error('invalid_select');
 const fields=[];let depth=0,start=0;
 for(let i=0;i<=input.length;i++){
  const c=input[i];if(c==='(')depth++;if(c===')')depth--;
  if(depth<0||depth>1)throw new Error('invalid_select');
  if(i===input.length||(c===','&&depth===0)){const part=input.slice(start,i);start=i+1;
   if(part==='*'||ID.test(part)){fields.push({key:part});continue;}
   const match=part.match(/^(?:(organization|business):)?(organizations|businesses|partner_details)(?:![a-z_]+)?\(([a-z_,]+)\)$/);
   if(!match)throw new Error('invalid_select');fields.push({key:match[1]||match[2],relation:match[2],columns:match[3].split(',')});
  }
 }
 if(depth)throw new Error('invalid_select');return fields;
}
export function projection(row,fields){
 const result={};for(const field of fields){if(field.key==='*'){for(const [key,value]of Object.entries(row))if(!['organization','business','partner_details'].includes(key))result[key]=value;continue;}
  if(!field.relation){if(!Object.hasOwn(row,field.key))throw new Error('invalid_column');result[field.key]=row[field.key];continue;}
  const value=row[field.key];const pick=item=>Object.fromEntries(field.columns.map(key=>{if(!Object.hasOwn(item,key))throw new Error('invalid_column');return [key,item[key]];}));
  result[field.key]=value===null?null:Array.isArray(value)?value.map(pick):pick(value);
 }return result;
}
export function readQuery(table,params){
 if(!TABLES.has(table))throw new Error('invalid_table');
 const fields=selectFields(params.get('select')||'*'),filters=[];
 for(const [column,expression]of params){if(['select','order','limit','offset'].includes(column))continue;
  if(!ID.test(column))throw new Error('invalid_filter');
  if(expression.startsWith('eq.'))filters.push({column,op:'eq',value:expression.slice(3)});
  else if(/^in\.\([^()]*\)$/.test(expression))filters.push({column,op:'in',values:expression.slice(4,-1).split(',').filter(Boolean).map(x=>x.replace(/^"|"$/g,''))});
  else throw new Error('unsupported_filter');
 }
 const order=(params.get('order')||(table==='partner_details'?'organization_id.asc':'id.asc')).split(',').map(value=>{const [column,direction='asc',...extra]=value.split('.');
  if(!ID.test(column)||!['asc','desc'].includes(direction)||extra.length)throw new Error('invalid_order');return {column,direction};});
 const limit=Number(params.get('limit')||1000),offset=Number(params.get('offset')||0);
 if(!Number.isInteger(limit)||limit<1||limit>1000||!Number.isInteger(offset)||offset<0||offset>1000000)throw new Error('invalid_range');
 return {request:{table,filters,order,limit,offset},fields};
}
