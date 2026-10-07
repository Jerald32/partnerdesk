import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/lib/AuthContext';
import { invokeAppAuth } from '@/lib/appAuth';
import { readRows } from '@/lib/supabaseData';
import { useRpcAction } from '@/hooks/useRpcAction';
import { Bell, AlertTriangle, AlertCircle, CheckCircle2, MessageSquare, UserCheck, Check } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

const TYPE_CONFIG = {
  sla_warning: { icon: AlertTriangle, color: 'text-orange-400', bg: 'bg-orange-500/10', label: 'SLA 경고' },
  sla_breach: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/10', label: 'SLA 초과' },
  status_change: { icon: CheckCircle2, color: 'text-blue-400', bg: 'bg-blue-500/10', label: '상태 변경' },
  new_comment: { icon: MessageSquare, color: 'text-primary', bg: 'bg-primary/10', label: '새 댓글' },
  assignment: { icon: UserCheck, color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: '배정' },
};

export default function Notifications() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  const { user } = useAuth();
  const [refresh,setRefresh] = useState(0);
  const [loadError,setLoadError] = useState('');
  const {run,busy,error,unknown} = useRpcAction(()=>setRefresh(v=>v+1));
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setLoadError('');
    async function load(){try{
      await invokeAppAuth('validate-session');if(controller.signal.aborted)return;
      const rows=await readRows(()=>supabase.from('notifications').select('id,ticket_id,type,message,is_read,created_at',{count:'exact'}).eq('recipient_profile_id',user.id).order('created_at',{ascending:false}).order('id'),controller.signal);
      if(!controller.signal.aborted)setNotifications(rows);
    }catch{if(!controller.signal.aborted)setLoadError('알림을 조회하지 못했습니다. 세션과 권한을 확인해 주세요.');}
    finally{if(!controller.signal.aborted)setLoading(false);}}
    void load();return()=>controller.abort();
  },[user.id,refresh]);
  const markRead = id => run('mark_notifications_read',{p_notification_id:id},data=>Number.isInteger(data?.count)&&data.count>=0);
  const markAllRead = () => markRead(null);

  const unreadCount = notifications.filter(n => !n.is_read).length;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">알림</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {unreadCount > 0 ? `${unreadCount}개 읽지 않음` : '모두 읽음'}
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            disabled={busy || unknown || loading}
            onClick={markAllRead}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Check className="w-3.5 h-3.5" /> 모두 읽음 처리
          </button>
        )}
      </div>

      {(loadError || error) && <p role="alert" className="text-xs text-destructive">{loadError || error}</p>}
      <div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
        {loading ? (
          Array(5).fill(0).map((_, i) => (
            <div key={i} className="flex items-start gap-3 p-4 animate-pulse">
              <div className="w-8 h-8 rounded-full bg-accent shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 bg-accent rounded w-3/4" />
                <div className="h-2.5 bg-accent rounded w-1/2" />
              </div>
            </div>
          ))
        ) : notifications.length === 0 ? (
          <div className="py-12 text-center">
            <Bell className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">알림이 없습니다</p>
          </div>
        ) : (
          notifications.map(notif => {
            const conf = TYPE_CONFIG[notif.type] || TYPE_CONFIG.status_change;
            const Icon = conf.icon;
            return (
              <div
                key={notif.id}
                className={cn(
                  "flex items-start gap-3 p-4 cursor-pointer transition-colors",
                  notif.is_read ? "hover:bg-accent/50" : "bg-primary/5 hover:bg-primary/10"
                )}
                onClick={() => {
                  if (busy || unknown) return;
                  if (!notif.is_read) void markRead(notif.id);
                  if (notif.ticket_id) navigate(`/tickets/${notif.ticket_id}`);
                }}
              >
                <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0", conf.bg)}>
                  <Icon className={cn("w-4 h-4", conf.color)} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className={cn("text-xs font-medium px-1.5 py-0.5 rounded", conf.bg, conf.color)}>
                        {conf.label}
                      </span>
                    </div>
                    {!notif.is_read && (
                      <div className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1" />
                    )}
                  </div>
                  <p className="text-sm text-foreground mt-1">{notif.message}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {format(new Date(notif.created_at), 'yyyy/MM/dd HH:mm')}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
