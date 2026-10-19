@echo off
cd /d "%~dp0"
set "DANCE_DATA_DIR=%~dp0.local\dance-data"
set "PORT=8792"
node scripts/init-dance.mjs
if errorlevel 1 exit /b 1
node --env-file-if-exists=.env server/dance/start.mjs
pause
