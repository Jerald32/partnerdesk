import { useState, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Camera, Check, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function ProfileEditForm({ currentUser, roleColor, onSaved, onCancel }) {
  const [displayName, setDisplayName] = useState(currentUser?.display_name || '');
  const [jobTitle, setJobTitle] = useState(currentUser?.job_title || '');
  const [imageUrl, setImageUrl] = useState(currentUser?.profile_image_url || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError('');
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setImageUrl(file_url);
    } catch (err) {
      setError('이미지 업로드 실패');
    }
    setUploading(false);
  };

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      await base44.auth.updateMe({
        display_name: displayName,
        job_title: jobTitle,
        profile_image_url: imageUrl,
      });
      setSaving(false);
      onSaved?.();
    } catch (err) {
      setError(err.message || '저장 실패'); setSaving(false);
    }
  };

  const inputClass = "w-full h-8 px-3 text-sm bg-accent border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";
  const labelClass = "block text-xs font-medium text-muted-foreground mb-1";

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">프로필 편집</h3>
        <button onClick={onCancel} disabled={saving} className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50">
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground">이름·직책·사진은 직접 수정 가능합니다. 소속과 역할은 별도 승인 요청이 필요합니다.</p>

      {/* Profile image */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className={cn("relative w-16 h-16 rounded-full overflow-hidden flex items-center justify-center text-lg font-bold group", roleColor)}
        >
          {imageUrl ? (
            <img src={imageUrl} alt="profile" className="w-full h-full object-cover" />
          ) : (
            currentUser?.full_name?.[0]?.toUpperCase() || currentUser?.email?.[0]?.toUpperCase() || 'U'
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
            {uploading ? <Loader2 className="w-4 h-4 text-white animate-spin" /> : <Camera className="w-4 h-4 text-white" />}
          </span>
        </button>
        <div>
          <p className="text-xs font-medium text-foreground">프로필 사진</p>
          <p className="text-[11px] text-muted-foreground">클릭하여 이미지 업로드</p>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      </div>

      {/* Display name */}
      <div>
        <label className={labelClass}>이름</label>
        <input
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder={currentUser?.full_name || '이름 입력'}
          className={inputClass}
        />
      </div>

      {/* Job title */}
      <div>
        <label className={labelClass}>직책</label>
        <input
          value={jobTitle}
          onChange={e => setJobTitle(e.target.value)}
          placeholder="예: 책임, 팀장, 대리"
          className={inputClass}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} disabled={saving} className="h-8 px-4 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors disabled:opacity-50">취소</button>
        <button onClick={handleSave} disabled={saving || uploading} className="flex items-center gap-1.5 h-8 px-4 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
          <Check className="w-3.5 h-3.5" /> {saving ? '저장 중...' : '저장'}
        </button>
      </div>
    </div>
  );
}