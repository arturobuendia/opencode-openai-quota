# Removes only this plugin's discovered directory; it never touches other plugins.
$ErrorActionPreference = 'Stop'
$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'opencode' } else { Join-Path $HOME '.config\opencode' }
$Destination = Join-Path $ConfigDir 'plugins\openai-quota'
if (Test-Path -LiteralPath $Destination) {
  Remove-Item -LiteralPath $Destination -Recurse -Force
  Write-Host "Removed: $Destination. Restart OpenCode." -ForegroundColor Green
} else {
  Write-Host "Plugin not found at: $Destination"
}
