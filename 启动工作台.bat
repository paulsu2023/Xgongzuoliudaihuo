@echo off
cd /d "%~dp0"
start "AI 带货工作流" http://127.0.0.1:4318
node server.js
pause
