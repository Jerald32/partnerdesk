# Reuse the existing Supabase CLI credential without printing credentials.
param([ValidateSet('Inspect','Configure','Verify')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
$projectRef='bqtlopwgjvvugalktldr'
if (-not ('PartnerDesk.Credential' -as [type])) {
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace PartnerDesk {
 public class Credential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Entry { public int Flags; public int Type; public string TargetName; public string Comment;
   public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
   public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern bool Read(string target,int type,int reserved,out IntPtr entry);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr entry);
  public static string Get() {
   IntPtr pointer;
   if(!Read("Supabase CLI:supabase",1,0,out pointer)) throw new Exception("supabase_cli_credential_unavailable");
   try { Entry e=(Entry)Marshal.PtrToStructure(pointer,typeof(Entry));byte[] bytes=new byte[e.CredentialBlobSize];
    Marshal.Copy(e.CredentialBlob,bytes,0,bytes.Length);
    return (Array.IndexOf(bytes,(byte)0)>=0?System.Text.Encoding.Unicode:System.Text.Encoding.UTF8).GetString(bytes).TrimEnd('\0');
   } finally { CredFree(pointer); }
  }
 }
}
'@
}
$token=[PartnerDesk.Credential]::Get()
$headers=@{Authorization="Bearer $token"}
if($Mode -eq 'Verify') {
 try {
  $secrets=Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$projectRef/database/query" -Headers $headers -ContentType 'application/json' -Body (@{query="SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='inactivity_cron_secret'"}|ConvertTo-Json)
  $result=Invoke-RestMethod -Method Post -Uri "https://$projectRef.supabase.co/functions/v1/inactivity-mail" -Headers @{Authorization=('Bearer '+$secrets[0].decrypted_secret)} -ContentType 'application/json' -Body '{}'
  $result | ConvertTo-Json
 }catch {
  $status=0
  if($_.Exception.Response) {$status=[int]$_.Exception.Response.StatusCode}
  Write-Output ('Worker HTTP status: '+$status)
  if($_.Exception.Response) {
   try { $reader=New-Object IO.StreamReader($_.Exception.Response.GetResponseStream());$body=$reader.ReadToEnd()|ConvertFrom-Json;Write-Output ('Worker response: '+$body.error+' '+$body.code+' '+$body.message) }catch{}
  }
  if($_.ErrorDetails.Message) {
   try {$detail=$_.ErrorDetails.Message|ConvertFrom-Json;Write-Output ('Worker error code: '+$detail.error+' '+$detail.code)}catch{}
  }
  throw 'inactivity_worker_verification_failed'
 }
 exit
}
try { $auth=Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$projectRef/config/auth" -Headers $headers }
catch { throw 'supabase_auth_config_read_failed' }
$fields=@('smtp_host','smtp_port','smtp_user','smtp_admin_email')
$ready=$true
foreach($field in $fields) { if(-not $auth.$field) {$ready=$false} }
if($Mode -eq 'Inspect') {
 [pscustomobject]@{smtp_settings_present=$ready;host=$auth.smtp_host;port=$auth.smtp_port;sender_present=[bool]$auth.smtp_admin_email;note='Actual SMTP password must be registered directly as INACTIVITY_SMTP_PASSWORD; Auth configuration response is not reusable.'} | ConvertTo-Json
 exit
}
if(-not $ready) { throw 'existing_smtp_credentials_incomplete' }
$bytes=New-Object byte[] 32
$rng=[Security.Cryptography.RandomNumberGenerator]::Create();$rng.GetBytes($bytes);$rng.Dispose()
$cronSecret=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
$values=@{
 INACTIVITY_CRON_SECRET=$cronSecret;INACTIVITY_SMTP_HOST=$auth.smtp_host;INACTIVITY_SMTP_PORT=[string]$auth.smtp_port;
 INACTIVITY_SMTP_USER=$auth.smtp_user;INACTIVITY_SMTP_FROM=$auth.smtp_admin_email
}
$secretPath=Join-Path $env:TEMP ('partnerdesk-inactivity-'+[guid]::NewGuid().ToString('N')+'.env')
try {
 $lines=foreach($key in $values.Keys) { $key+'='+($values[$key] | ConvertTo-Json -Compress) }
 [IO.File]::WriteAllLines($secretPath,$lines,(New-Object Text.UTF8Encoding($false)))
 $acl=Get-Acl -LiteralPath $secretPath
 $acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().Name,'FullControl','Allow')))
 Set-Acl -LiteralPath $secretPath -AclObject $acl
 & npx.cmd supabase secrets set --project-ref $projectRef --env-file $secretPath
 if($LASTEXITCODE -ne 0) {throw 'inactivity_secret_configuration_failed'}
 $sql=@"
DO `$`$ DECLARE existing uuid; BEGIN
 SELECT id INTO existing FROM vault.secrets WHERE name='inactivity_cron_secret';
 IF existing IS NULL THEN PERFORM vault.create_secret('$cronSecret','inactivity_cron_secret');
 ELSE PERFORM vault.update_secret(existing,'$cronSecret'); END IF;
 SELECT id INTO existing FROM vault.secrets WHERE name='inactivity_mail_url';
 IF existing IS NULL THEN PERFORM vault.create_secret('https://$projectRef.supabase.co/functions/v1/inactivity-mail','inactivity_mail_url');
 ELSE PERFORM vault.update_secret(existing,'https://$projectRef.supabase.co/functions/v1/inactivity-mail'); END IF;
END `$`$;
"@
 try { $null=Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$projectRef/database/query" -Headers $headers -ContentType 'application/json' -Body (@{query=$sql}|ConvertTo-Json) }
 catch {throw 'inactivity_vault_configuration_failed'}
 Write-Output 'Inactivity SMTP and scheduler secrets configured; values withheld.'
} finally {
 if(Test-Path -LiteralPath $secretPath) {Remove-Item -LiteralPath $secretPath}
 $token=$null;$headers=$null;$auth=$null;$values=$null;$cronSecret=$null
}
