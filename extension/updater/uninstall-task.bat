@echo off
:: Removes the OnshapeAssistantUpdate scheduled task.
:: Run as Administrator.

set TASK_NAME=OnshapeAssistantUpdate

schtasks /delete /tn "%TASK_NAME%" /f

if %errorlevel%==0 (
    echo Task "%TASK_NAME%" removed.
) else (
    echo Task not found or failed to remove. Try running as Administrator.
)

pause
