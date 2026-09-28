@echo off
rem 启动常驻面板（若核心没在运行会自动拉起）。
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
