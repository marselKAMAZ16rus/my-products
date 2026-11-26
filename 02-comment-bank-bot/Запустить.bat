@echo off
cd /d "%~dp0"
py main.py
if errorlevel 1 (
  echo.
  echo Program exited with an error.
  pause
)
