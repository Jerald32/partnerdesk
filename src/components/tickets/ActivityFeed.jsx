import { Send, Lock, MessageSquare, GitBranch, UserCheck } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

const TYPE_ICONS = {
  comment: MessageSquare,
  status_change: GitBranch,
  note: Lock,
  assignment: UserCheck,
};

const TYPE_COLORS = {
  comment: 'text-blue-400',
  status_change: 'text-emerald-400',
  note: 'text-orange-400',
  assignment: 'text-purple-400',
};

export default function ActivityFeed({ activities, userRole, requestDetail, requestType, disabled = false, onSubmit }) {
  const [isInternal, setIsInternal] = useState(false);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const canNote = ['admin', 'operator'].includes(userRole);
  const canWrite = ['admin', 'operator', 'partner_admin'].includes(userRole) && Boolean(onSubmit);
  async function send() {
    if (pending.current || disabled || !canWrite || !content.trim()) return;
    pending.current = true;
    setSending(true);
    try {
      if (await onSubmit(isInternal && canNote ? 'note' : 'comment', content.trim())) setContent('');
    } finally { pending.current = false; setSending(false); }
  }
  return (
    <div className="flex flex-col h-full">
      {/* Input (상단) */}
      <div className="border-b border-border pb-3 mb-3">
        {requestDetail && (
          <div className="mb-3 rounded-md bg-accent/60 border border-border p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <MessageSquare className="w-3 h-3 text-primary" />
              <span className="text-[11px] font-semibold text-primary">고객 요청사항</span>
              {requestType && (
                <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-accent ml-1">{requestType}</span>
              )}
            </div>
            <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">{requestDetail}</p>
          </div>
        )}
        {['admin', 'operator'].includes(userRole) && (
          <div className="flex items-center gap-2 mb-2">
            <button
              disabled={disabled || sending}
              onClick={() => setIsInternal(false)}
              className={cn("text-xs px-3 py-1.5 rounded-md transition-colors",
                !isInternal ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              댓글
            </button>
            <button
              disabled={disabled || sending}
              onClick={() => setIsInternal(true)}
              className={cn("flex items-center gap-1 text-xs px-3 py-1.5 rounded-md transition-colors",
                isInternal ? "bg-orange-500/20 text-orange-400 font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Lock className="w-3 h-3" /> 내부 노트
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            disabled={disabled || sending || !canWrite}
            value={content}
            onChange={event => setContent(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
            placeholder={isInternal && canNote ? '내부 노트 (파트너에게 비공개)...' : '댓글을 입력하세요... (Ctrl+Enter로 전송)'}
            rows={4}
            className={cn(
              "flex-1 px-3 py-2.5 text-sm border rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-ring",
              isInternal
                ? "bg-orange-500/5 border-orange-500/30 text-foreground placeholder-muted-foreground"
                : "bg-accent border-border text-foreground placeholder-muted-foreground"
            )}
          />
          <button
            disabled={disabled || sending || !canWrite || !content.trim()}
            onClick={send}
            className="h-11 w-11 flex items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 self-end"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* History (스크롤) */}
      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {activities.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">활동 내역이 없습니다</div>
        ) : (
          activities.map(act => {
            const Icon = TYPE_ICONS[act.type] || MessageSquare;
            const isSystemEvent = act.type === 'status_change' || act.type === 'assignment';

            if (isSystemEvent) {
              return (
                <div key={act.id} className="flex items-center gap-2 py-1">
                  <div className="w-5 h-px bg-border flex-1" />
                  <div className={cn("flex items-center gap-1.5 text-xs", TYPE_COLORS[act.type])}>
                    <Icon className="w-3 h-3" />
                    <span>{act.content}</span>
                  </div>
                  <div className="w-5 h-px bg-border flex-1" />
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {format(new Date(act.created_at), 'MM/dd HH:mm')}
                  </span>
                </div>
              );
            }

            return (
              <div key={act.id} className={cn("flex gap-2.5", act.is_internal && "opacity-80")}>
                <div className={cn(
                  "w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5",
                  act.actor_role_snapshot === 'admin' ? "bg-primary/30 text-primary" :
                  act.actor_role_snapshot === 'operator' ? "bg-orange-500/30 text-orange-400" :
                  "bg-emerald-500/30 text-emerald-400"
                )}>
                  {act.actor_name_snapshot?.[0]?.toUpperCase() || 'U'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-foreground">{act.actor_name_snapshot || 'Unknown'}</span>
                    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium",
                      act.actor_role_snapshot === 'admin' ? "bg-primary/15 text-primary" :
                      act.actor_role_snapshot === 'operator' ? "bg-orange-500/15 text-orange-400" :
                      "bg-emerald-500/15 text-emerald-400"
                    )}>
                      {act.actor_role_snapshot}
                    </span>
                    {act.is_internal && (
                      <span className="flex items-center gap-0.5 text-[10px] text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">
                        <Lock className="w-2.5 h-2.5" /> 내부
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {format(new Date(act.created_at), 'MM/dd HH:mm')}
                    </span>
                  </div>
                  <div className={cn(
                    "rounded-lg px-3 py-2 text-sm text-foreground",
                    act.is_internal ? "bg-orange-500/10 border border-orange-500/20" : "bg-accent"
                  )}>
                    {act.content}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
import { useState, useRef } from 'react';
