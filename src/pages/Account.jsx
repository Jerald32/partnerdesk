import { useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { useRpcAction } from '@/hooks/useRpcAction';
import RoleRequestForm from '@/components/users/RoleRequestForm';

export default function Account() {
  const { user,checkUserAuth } = useAuth();
  const [form,setForm] = useState({full_name:user.full_name || '',display_name:user.display_name || '',job_title:user.job_title || ''});
  const [saved,setSaved] = useState(false);
  const {run,busy,error,unknown} = useRpcAction(()=>{setSaved(true);void checkUserAuth();});
  return <div className="max-w-xl space-y-4"><h2 className="text-lg font-semibold">내 계정</h2>
    <p className="text-xs text-muted-foreground">{user.email} · {user.role}</p>
    <form onSubmit={e=>{e.preventDefault();setSaved(false);void run('update_my_profile',{p_full_name:form.full_name,p_display_name:form.display_name,p_job_title:form.job_title});}} className="rounded-lg border border-border bg-card p-5 space-y-3">
      {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}{saved&&<p role="status" className="text-xs text-primary">저장되었습니다.</p>}
      <fieldset disabled={busy||unknown} className="space-y-3">{[['full_name','이름'],['display_name','표시 이름'],['job_title','직책']].map(([key,label])=><label key={key} className="block text-xs text-muted-foreground">{label}<input maxLength={200} value={form[key]} onChange={e=>setForm(f=>({...f,[key]:e.target.value}))} className="mt-1 w-full h-8 px-3 border border-border rounded bg-accent text-foreground" /></label>)}
      <button className="px-3 py-2 rounded bg-primary text-primary-foreground text-xs">저장</button></fieldset>
    </form>
    <RoleRequestForm />
  </div>;
}
