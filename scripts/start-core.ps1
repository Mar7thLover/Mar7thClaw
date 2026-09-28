# 只在后台启动核心（HTTP 面板服务 + Discord bot），不打开桌面窗口。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 18790
$configFile = Join-Path $root 'data\config.json'
if (Test-Path -LiteralPath $configFile) { $cfg = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json; if ($cfg.port) { $port = $cfg.port } }
try { $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2; if ($health.name -eq 'mar7thclaw') { Write-Output "Mar7thClaw 核心已在运行：http://127.0.0.1:$port/"; exit 0 } } catch {}
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd'
$node = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $root 'src\index.js') + '"') -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir "core-$stamp.out.log") -RedirectStandardError (Join-Path $logDir "core-$stamp.err.log") | Out-Null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try { $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2; if ($health.name -eq 'mar7thclaw') { Write-Output "Mar7thClaw 核心已启动：http://127.0.0.1:$port/"; exit 0 } } catch {}
}
throw "核心没有在 10 秒内就绪，请查看 $logDir 下的日志"
