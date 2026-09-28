# 开机（登录）后自动启动 Mar7thClaw 面板；面板会顺带拉起核心与 Discord bot。
# 写入当前用户的登录项（HKCU\...\Run），不需要管理员权限。托盘菜单里也可以随时开关。
param([switch]$Off)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\Mar7thClaw.exe'
if (-not (Test-Path -LiteralPath $electron)) { $electron = Join-Path $root 'node_modules\electron\dist\electron.exe' }
if (-not (Test-Path -LiteralPath $electron)) { throw "找不到 Electron：$electron，请先在 $root 运行 npm install" }
$mode = if ($Off) { 'off' } else { 'on' }
$output = & $electron $root --set-autostart $mode | Out-String
Write-Output $output.Trim()
