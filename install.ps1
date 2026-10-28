# Run from the extracted project directory: .\install.ps1
# Installs the plugin via OpenCode V2 global plugin discovery.
$ErrorActionPreference = 'Stop'
$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode' } else { Join-Path $HOME '.config\opencode' }
$PluginsDir = Join-Path $ConfigDir 'plugins'
$Destination = Join-Path $PluginsDir 'openai-quota'
New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null
if (Test-Path -LiteralPath $Destination) {
  # IMPORTANT: never place backups under plugins/ because V2 auto-discovers them.
  $BackupsDir = Join-Path $ConfigDir 'openai-quota-backups'
  New-Item -ItemType Directory -Path $BackupsDir -Force | Out-Null
  $Backup = Join-Path $BackupsDir "openai-quota.$(Get-Date -Format yyyyMMddHHmmssfff)"
  Move-Item -LiteralPath $Destination -Destination $Backup
  Write-Host "Previous version backed up to: $Backup" -ForegroundColor Yellow
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'src') -Destination (Join-Path $Destination 'src') -Recurse -Force
foreach ($File in @('index.ts','tui.tsx','tsconfig.json','package.json')) {
  Copy-Item (Join-Path $PSScriptRoot $File) (Join-Path $Destination $File) -Force
}
Write-Host "Installed plugin in: $Destination" -ForegroundColor Green
if (-not (Get-Command 'codex' -ErrorAction SilentlyContinue)) {
  Write-Host 'Codex CLI was not found in PATH. Install it and run codex login.' -ForegroundColor Yellow
} else {
  Write-Host 'Codex is available. Verify the correct account with: codex login status'
}
Write-Host 'Restart OpenCode V2. Open a session sidebar to see OpenAI Quota.'
Write-Host 'This installer did not modify opencode.json, cli.json, auth.json or your other plugins.'

# Older installers used to place backups *inside* plugins/. Do not silently
# delete anything, but warn that discovery may load copies of the same plugin.
Get-ChildItem -LiteralPath $PluginsDir -Directory -Filter 'openai-quota.backup.*' -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "Old backup under plugins may be auto-loaded: $($_.FullName)" -ForegroundColor Yellow
  Write-Host 'Move it outside the plugins directory if it exists.' -ForegroundColor Yellow
}
