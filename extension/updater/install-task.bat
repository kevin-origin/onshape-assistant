@echo off
:: One-time setup: creates a Windows Scheduled Task that runs git-pull.bat
:: every hour to keep the extension up to date.
:: Run this as Administrator on each device.

set TASK_NAME=OnshapeAssistantUpdate
set SCRIPT_PATH=%~dp0git-pull.bat

:: Delete existing task if present (to allow re-running installer)
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: Create hourly task that runs whether user is logged in or not
schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%SCRIPT_PATH%\"" ^
  /sc HOURLY ^
  /mo 1 ^
  /f

if %errorlevel%==0 (
    echo Task "%TASK_NAME%" created successfully.
    echo The extension will auto-pull from main every hour.
) else (
    echo Failed to create task. Try running as Administrator.
)

pause
