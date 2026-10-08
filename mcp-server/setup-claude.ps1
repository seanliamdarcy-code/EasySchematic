param(
  [ValidateRange(1024, 65535)][int]$Port = 8766,
  [string]$Origin = 'https://testschematic.tateside.online',
  [string]$ConfigPath = (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json'),
  [string]$TokenFile = (Join-Path $env:USERPROFILE '.config/easyschematic-mcp/pairing-token')
)
$ErrorActionPreference = 'Stop'
$entryPoint = Join-Path $PSScriptRoot 'dist/index.js'
if (!(Test-Path -LiteralPath $entryPoint)) { throw 'Build first: npm ci --prefix mcp-server; npm test --prefix mcp-server' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeMajor = & $nodePath -p 'process.versions.node.split(".")[0]'
if ([int]$nodeMajor -lt 24) { throw 'Install Node.js 24 or later before configuring the bridge.' }
$originUri = [Uri]$Origin
if (!$originUri.IsAbsoluteUri -or $originUri.Scheme -ne 'https' -or $originUri.AbsolutePath -ne '/' -or $originUri.Query -or $originUri.Fragment -or $originUri.UserInfo) {
  throw 'Origin must be an HTTPS origin without a path, query or credentials.'
}
$Origin = $originUri.GetLeftPart([UriPartial]::Authority)
$TokenFile = [IO.Path]::GetFullPath($TokenFile)
$tokenDirectory = Split-Path -Parent $TokenFile
New-Item -ItemType Directory -Path $tokenDirectory -Force | Out-Null
$executingSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $tokenDirectory /inheritance:r /grant:r "*${executingSid}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not protect pairing-token directory.' }
if (!(Test-Path -LiteralPath $TokenFile)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  [IO.File]::WriteAllText($TokenFile, ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant())
}
& icacls $TokenFile /inheritance:r /grant:r "*${executingSid}:F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not protect pairing-token file.' }
if ([IO.File]::ReadAllText($TokenFile).Trim().Length -lt 32) { throw 'Pairing token file is invalid.' }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$config = if (Test-Path -LiteralPath $ConfigPath) { Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if ($config -isnot [pscustomobject]) { throw 'Existing Claude configuration is not a JSON object.' }
if (!$config.PSObject.Properties['mcpServers']) { $config | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
if ($config.mcpServers -isnot [pscustomobject]) { throw 'mcpServers must be a JSON object.' }
$server = [pscustomobject]@{
  command = $nodePath
  args = @([IO.Path]::GetFullPath($entryPoint))
  env = [pscustomobject]@{
    EASYSCHEMATIC_MCP_PORT = "$Port"
    EASYSCHEMATIC_MCP_ORIGINS = $Origin
    EASYSCHEMATIC_MCP_TOKEN_FILE = $TokenFile
  }
}
if (Test-Path -LiteralPath $ConfigPath) {
  Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $tokenDirectory "claude-config-backup-$([Guid]::NewGuid().ToString('N')).json")
}
$config.mcpServers | Add-Member -NotePropertyName easyschematic -NotePropertyValue $server -Force
New-Item -ItemType Directory -Path (Split-Path -Parent $ConfigPath) -Force | Out-Null
[IO.File]::WriteAllText($ConfigPath, ($config | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding $false))
Write-Output "Claude Desktop configured on port $Port. Restart Claude, run mcp-server/copy-pairing-token.ps1, then pair the editor under File > Preferences > AI (Beta)."
