@echo off
powershell.exe -NoProfile -STA -File "%~dp0setup-aliyun-voice.ps1"
if errorlevel 1 pause
