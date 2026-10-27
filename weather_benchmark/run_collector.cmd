@echo off
rem Launcher for the Weather HQ collector, used by the "WeatherHQ Collector"
rem scheduled task. Pins the working directory (collector.py uses relative
rem paths for config/data) and finds a usable Python (find_python.cmd).
goto :main
rem ---------------------------------------------------------------------------------------------------------------
exit /b 0
rem ^ byte 367: where a cmd.exe still running the pre-2026-10-26 launcher
rem resumes when its python exits. Keep everything above it byte-stable.
:main
rem Logs go to collector.log (size-rotated by collector.py); collector.out.log
rem only catches output from before logging starts, e.g. import errors.
cd /d "%~dp0"
call "%~dp0find_python.cmd"
if not defined PYEXE (
  echo [%date% %time%] run_collector: no Python with requests/yaml/Pillow found>> collector.out.log
  exit /b 9009
)
rem Roll the stderr capture once it passes ~5 MB
for %%F in (collector.out.log) do if %%~zF GTR 5000000 move /y collector.out.log collector.out.log.1 >nul 2>&1
echo [%date% %time%] starting collector with %PYEXE%>> collector.out.log
"%PYEXE%" collector.py --log-file collector.log >> collector.out.log 2>&1
