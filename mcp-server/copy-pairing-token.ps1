$ErrorActionPreference = 'Stop'
$tokenPath = if ($env:EASYSCHEMATIC_MCP_TOKEN_FILE) { $env:EASYSCHEMATIC_MCP_TOKEN_FILE } else { Join-Path $env:USERPROFILE '.config/easyschematic-mcp/pairing-token' }
Set-Clipboard -Value ([IO.File]::ReadAllText($tokenPath).Trim())
Write-Output 'Pairing token copied. Paste into File > Preferences > AI (Beta).'
