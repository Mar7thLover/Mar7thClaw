@echo off
rem 启动常驻面板（若核心没在运行会自动拉起）。优先使用带头像图标的 Mar7thClaw.exe。
cd /d "%~dp0"
set "EXE=%~dp0node_modules\electron\dist\Mar7thClaw.exe"
if not exist "%EXE%" set "EXE=%~dp0node_modules\electron\dist\electron.exe"
start "" "%EXE%" "%~dp0."
