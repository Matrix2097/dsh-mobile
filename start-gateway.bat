@echo off
chcp 65001 >nul
title DSH Mobile Gateway
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-gateway.ps1" %*
echo.
echo Gateway exited. Press any key to close...
pause >nul
