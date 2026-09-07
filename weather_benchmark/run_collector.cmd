@echo off
rem Launcher for the Weather HQ collector — used by the "WeatherHQ Collector"
rem scheduled task. Pins the working directory (collector.py uses relative
rem paths for config/data) and appends console output to collector.out.log.
cd /d "%~dp0"
"C:\Users\John\AppData\Local\Programs\Python\Python312\python.exe" collector.py >> collector.out.log 2>&1
