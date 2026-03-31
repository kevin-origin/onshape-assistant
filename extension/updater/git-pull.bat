@echo off
:: Pulls latest extension code from main branch
:: Called by Windows Task Scheduler on an interval

:: Navigate to the repo root (one level up from updater/)
cd /d "%~dp0..\.."

:: Pull latest from main (extension updates go to main)
git pull origin main --quiet

:: Log timestamp for debugging
echo [%date% %time%] Pull completed >> "%~dp0update.log"
