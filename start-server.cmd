@echo off
chcp 65001 >nul
title 油条 本地服务
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 node 命令。请先安装 Node.js：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 油条 本地服务...
echo.

node serve.mjs --open

echo.
echo   服务已退出。
pause
