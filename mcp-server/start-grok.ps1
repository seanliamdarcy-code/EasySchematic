param(
  [switch]$Stop,
  [ValidateRange(1024,65535)][int]$HttpPort = 8768,
  [ValidateRange(1024,65535)][int]$BridgePort = 8765,
  [string]$Origin = 'https://testschematic.tateside.online',
  [string]$StateDirectory = (Join-Path $env:USERPROFILE '.config/easyschematic-mcp/grok')
)
$ErrorActionPreference = 'Stop'
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$statePath = Join-Path $StateDirectory 'processes.json'
function Stop-OwnedProcess($record) {
  $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
  if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq $record.startedTicks) {
    Stop-Process -Id $record.id -ErrorAction Stop
    Wait-Process -Id $record.id -Timeout 5 -ErrorAction SilentlyContinue
  }
}
if (Test-Path -LiteralPath $statePath) {
  $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $alive = @($previous.processes | Where-Object {
    $process = Get-Process -Id $_.id -ErrorAction SilentlyContinue
    $process -and $process.StartTime.ToUniversalTime().Ticks -eq $_.startedTicks
  })
  if (!$Stop -and $alive.Count) { throw 'Grok connector is already running. Use -Stop before restarting.' }
  if ($Stop) {
    foreach ($record in $previous.processes) { Stop-OwnedProcess $record }
    Remove-Item -LiteralPath $statePath
    Write-Output 'Grok connector stopped; its workstation OAuth grants are revoked.'
    return
  }
} elseif ($Stop) { Write-Output 'No managed Grok connector is running.'; return }
$entryPoint = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist/http.js'))
if (!(Test-Path -LiteralPath $entryPoint)) { throw 'Build first: npm test --prefix mcp-server' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
if ([int](& $nodePath -p 'process.versions.node.split(".")[0]') -lt 24) { throw 'Node.js 24 or later is required.' }
$tunnelPath = (Get-Command cloudflared -ErrorAction Stop).Source
if ($HttpPort -eq $BridgePort) { throw 'HTTP and editor bridge ports must differ.' }
if (Get-NetTCPConnection -LocalPort $HttpPort -State Listen -ErrorAction SilentlyContinue) { throw "Port $HttpPort is in use." }
$originUri = [Uri]$Origin
if (!$originUri.IsAbsoluteUri -or $originUri.Scheme -ne 'https' -or $originUri.AbsolutePath -ne '/' -or $originUri.Query -or $originUri.Fragment -or $originUri.UserInfo) { throw 'Origin must be an HTTPS origin.' }
$tokenPath = Join-Path $env:USERPROFILE '.config/easyschematic-mcp/pairing-token'
if (!(Test-Path -LiteralPath $tokenPath) -or [IO.File]::ReadAllText($tokenPath).Trim().Length -lt 32) { throw 'Set up the existing Codex/Claude pairing token first.' }
New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
$executingSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $StateDirectory /inheritance:r /grant:r "*${executingSid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not protect connector state directory.' }
$runId = [Guid]::NewGuid().ToString('N')
$tunnelLog = Join-Path $StateDirectory "tunnel-$runId.log"
$processes = @()
try {
  $tunnel = Start-Process -FilePath $tunnelPath -ArgumentList @('tunnel','--no-autoupdate','--logfile',"`"$tunnelLog`"",'--url',"http://127.0.0.1:$HttpPort") -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $StateDirectory "tunnel-$runId.stderr.log") -RedirectStandardOutput (Join-Path $StateDirectory "tunnel-$runId.stdout.log")
  $processes += [pscustomobject]@{ id=$tunnel.Id; startedTicks=$tunnel.StartTime.ToUniversalTime().Ticks }
  $publicUrl = $null
  for ($attempt=0; $attempt -lt 60; $attempt++) {
    if ($tunnel.HasExited) { throw 'Cloudflare tunnel exited. Check protected tunnel logs.' }
    if (Test-Path -LiteralPath $tunnelLog) {
      $stream = [IO.File]::Open($tunnelLog,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
      $reader = [IO.StreamReader]::new($stream)
      try { $logText = $reader.ReadToEnd() } finally { $reader.Dispose() }
      $match = [regex]::Match($logText,'https://[a-z0-9-]+\.trycloudflare\.com')
      if ($match.Success) { $publicUrl = $match.Value; break }
    }
    Start-Sleep -Milliseconds 500
  }
  if (!$publicUrl) { throw 'No tunnel URL was returned within 30 seconds.' }
  $variables = @{
    EASYSCHEMATIC_MCP_PUBLIC_URL = $publicUrl
    EASYSCHEMATIC_MCP_HTTP_PORT = "$HttpPort"
    EASYSCHEMATIC_MCP_PORT = "$BridgePort"
    EASYSCHEMATIC_MCP_ORIGINS = $originUri.GetLeftPart([UriPartial]::Authority)
    EASYSCHEMATIC_MCP_TOKEN_FILE = $tokenPath
  }
  $oldValues = @{}
  try {
    foreach ($key in $variables.Keys) { $oldValues[$key]=[Environment]::GetEnvironmentVariable($key,'Process'); [Environment]::SetEnvironmentVariable($key,$variables[$key],'Process') }
    $server = Start-Process -FilePath $nodePath -ArgumentList @("`"$entryPoint`"") -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $StateDirectory "server-$runId.stderr.log") -RedirectStandardOutput (Join-Path $StateDirectory "server-$runId.stdout.log")
  } finally { foreach ($key in $oldValues.Keys) { [Environment]::SetEnvironmentVariable($key,$oldValues[$key],'Process') } }
  $processes += [pscustomobject]@{ id=$server.Id; startedTicks=$server.StartTime.ToUniversalTime().Ticks }
  $ready = $false
  for ($attempt=0; $attempt -lt 20; $attempt++) {
    if ($server.HasExited) { throw 'Connector exited. Check protected server logs.' }
    try { $metadata = Invoke-RestMethod -Uri "http://127.0.0.1:$HttpPort/.well-known/oauth-protected-resource/mcp" -TimeoutSec 2; if ($metadata.resource -eq "$publicUrl/mcp") { $ready=$true; break } } catch {}
    Start-Sleep -Milliseconds 250
  }
  if (!$ready) { throw 'Connector did not become ready.' }
  [IO.File]::WriteAllText($statePath,([pscustomobject]@{url="$publicUrl/mcp";processes=$processes} | ConvertTo-Json -Depth 6))
  Write-Output "Grok connector URL: $publicUrl/mcp"
  Write-Output "Add it at https://grok.com/connectors > New Connector > Custom. Complete the OAuth approval using your existing pairing token. Pair the EasySchematic editor on port $BridgePort. Keep this workstation running."
  Write-Output 'Temporary URL changes on restart. Stop with: ./mcp-server/start-grok.ps1 -Stop'
} catch {
  foreach ($record in $processes) { Stop-OwnedProcess $record }
  throw
}
