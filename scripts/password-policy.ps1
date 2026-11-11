param([ValidateSet('Inspect','Apply','Probe','ProbeEndpoint')][string]$Mode='Inspect')
$ErrorActionPreference='Stop'
# Load only the existing CLI credential reader; never run mail configuration.
$source=Get-Content (Join-Path $PSScriptRoot 'inactivity-credentials.ps1') -Raw -Encoding UTF8
$start=$source.IndexOf('if (-not');$end=$source.IndexOf('$token=')
Invoke-Expression $source.Substring($start,$end-$start)
$headers=@{Authorization=('Bearer '+[PartnerDesk.Credential]::Get())}
$projectRef='bqtlopwgjvvugalktldr'
$endpoint="https://api.supabase.com/v1/projects/$projectRef/config/auth"
$policy=Get-Content (Join-Path $PSScriptRoot '../supabase/auth-password-policy.json') -Raw -Encoding UTF8|ConvertFrom-Json
try {
 $before=Invoke-RestMethod -Uri $endpoint -Headers $headers
 if($Mode -eq 'Apply') {
  try {$null=Invoke-RestMethod -Method Patch -Uri $endpoint -Headers $headers -ContentType 'application/json' -Body ($policy|ConvertTo-Json -Compress)}
  catch {throw 'password_policy_update_failed'}
  $after=Invoke-RestMethod -Uri $endpoint -Headers $headers
  if($after.password_min_length -ne $policy.password_min_length -or $after.password_required_characters -cne $policy.password_required_characters){throw 'password_policy_readback_mismatch'}
  $changes=@($after.PSObject.Properties.Name|Where-Object {
   ($before.$_|ConvertTo-Json -Depth 50 -Compress) -cne ($after.$_|ConvertTo-Json -Depth 50 -Compress)
  })
  if(@($changes|Where-Object {$_ -notin @('password_min_length','password_required_characters')}).Count){throw 'unexpected_auth_setting_changed'}
  [pscustomobject]@{applied=$true;changed_fields=$changes;minimum_length=$after.password_min_length;four_classes_required=$true}|ConvertTo-Json
 } elseif($Mode -eq 'Inspect') {
  $before|Select-Object password_min_length,password_required_characters,password_hibp_enabled,security_update_password_require_reauthentication|ConvertTo-Json
 } else {
  if($before.password_min_length -ne 8 -or $before.password_required_characters -cne $policy.password_required_characters){throw 'password_policy_not_ready'}
  $envText=Get-Content (Join-Path $PSScriptRoot '../.env.local') -Raw -Encoding UTF8
  $match=[regex]::Match($envText,'(?m)^VITE_SUPABASE_PUBLISHABLE_KEY=(.+)$')
  if(-not $match.Success){
   $envText=Get-Content (Join-Path $PSScriptRoot '../.env') -Raw -Encoding UTF8
   $match=[regex]::Match($envText,'(?m)^VITE_SUPABASE_PUBLISHABLE_KEY=(.+)$')
  }
  if(-not $match.Success){throw 'publishable_key_unavailable'}
  $apiHeaders=@{apikey=$match.Groups[1].Value.Trim().Trim([char]34).Trim([char]39)}
  $cases=@(
   @{name='short';password='Aa1!abc'},@{name='no_upper';password='abcdefgh1!'},
   @{name='no_lower';password='ABCDEFGH1!'},@{name='no_digit';password='Abcdefgh!'},
   @{name='no_symbol';password='Abcdefg1'},@{name='space_not_symbol';password='Abcdef1 '},
   @{name='unicode_not_symbol';password=('Abcdef1'+[char]0xD55C)}
  )
  if($Mode -eq 'ProbeEndpoint'){
   $cases+=@(@{name='space_with_symbol';password='Abcdef1! '},@{name='hangul_with_symbol';password=('Abcdef1!'+[char]0xD55C)},@{name='tab_with_symbol';password="Abcdef1!`t"})
  }
  foreach($case in $cases) {
   # No real email address or signup consent: a failed policy could not produce
   # a usable account. Every expected case must fail at the Auth policy itself.
   $target="https://$projectRef.supabase.co/auth/v1/signup"
   $payload=@{email=('password-policy-'+[guid]::NewGuid().ToString('N')+'@example.invalid');password=$case.password}
   if($Mode -eq 'ProbeEndpoint'){$target="https://$projectRef.supabase.co/functions/v1/password-policy";$payload=@{action='reset';password=$case.password}}
   $body=$payload|ConvertTo-Json -Compress
   $response=$null;$status=0
   try {$null=Invoke-RestMethod -Method Post -Uri $target -Headers $apiHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body));throw 'weak_password_unexpectedly_accepted'}
   catch {
    if($_.Exception.Response){
     $status=[int]$_.Exception.Response.StatusCode
     $reader=New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
     $response=$reader.ReadToEnd()|ConvertFrom-Json
    }else{throw 'password_probe_network_or_acceptance_failure'}
   }
   $errorCode=$response.error_code;if($Mode -eq 'ProbeEndpoint'){$errorCode=$response.error}
   if($status -ne 422 -or $errorCode -ne 'weak_password'){throw ('password_probe_rejected_for_unexpected_reason: '+$case.name+' '+$status+' '+$errorCode)}
   [pscustomobject]@{case=$case.name;status=$status;code=$errorCode}|ConvertTo-Json -Compress
  }
 }
} finally {$headers=$null;$before=$null;$after=$null;$apiHeaders=$null;$envText=$null}
