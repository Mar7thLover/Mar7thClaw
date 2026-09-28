# 优雅停止核心：中断进行中的任务、断开 Discord，然后退出。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 18790
$configFile = Join-Path $root 'data\config.json'
if (Test-Path -LiteralPath $configFile) { $cfg = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json; if ($cfg.port) { $port = $cfg.port } }
try { $html = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 3 } catch { Write-Output '核心没有在运行。'; exit 0 }
if ($html.Content -notmatch 'name="claw-token" content="([0-9a-f]+)"') { throw '无法读取面板令牌，端口上可能不是 Mar7thClaw' }
Invoke-RestMethod "http://127.0.0.1:$port/api/shutdown" -Method Post -Headers @{ 'x-claw-token' = $Matches[1] } | Out-Null
Write-Output '已请求核心退出。'
