@echo off
rem Launcher for the "WeatherHQ Health Alert" scheduled task (every 15 min).
rem Runs health_check.py --alert, which notifies when the newest record is
rem stale or duplicate collectors are writing. Last report: data\health_check_last.txt.
rem Exit code = health_check.py's (0 ok, 1 warn, 2 fail), shown as the task's Last Run Result.
cd /d "%~dp0"
call "%~dp0find_python.cmd"
if not defined PYEXE (
  msg %USERNAME% WeatherHQ health check: no Python with requests/yaml/Pillow found >nul 2>&1
  exit /b 9009
)
"%PYEXE%" health_check.py --alert > data\health_check_last.txt 2>&1
exit /b %ERRORLEVEL%
