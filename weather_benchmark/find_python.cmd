@echo off
rem Sets PYEXE to the first Python that can import the collector's deps.
rem Used by run_collector.cmd and run_health_check.cmd (scheduled tasks run
rem with a bare environment, so "python" on PATH is not to be trusted: it can
rem be the WindowsApps store stub, or a Python without requests/yaml).
rem
rem Order: %WEATHERHQ_PYTHON% (explicit override), .venv next to this file,
rem the per-user python.org installs (3.12 is the one the collector was set up
rem with), the py launcher, then anything else on PATH.
set "PYEXE="
call :try "%WEATHERHQ_PYTHON%"
call :try "%~dp0.venv\Scripts\python.exe"
call :try "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
call :try "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
call :try "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
call :try "%USERPROFILE%\AppData\Local\Programs\Python\Python312\python.exe"
call :try "%ProgramFiles%\Python312\python.exe"
set "PYLAUNCHER=py"
if exist "%WINDIR%\py.exe" set "PYLAUNCHER=%WINDIR%\py.exe"
if exist "%LOCALAPPDATA%\Programs\Python\Launcher\py.exe" set "PYLAUNCHER=%LOCALAPPDATA%\Programs\Python\Launcher\py.exe"
if not defined PYEXE for /f "delims=" %%P in ('"%PYLAUNCHER%" -3 -c "import sys;print(sys.executable)" 2^>nul') do call :try "%%P"
set "PYLAUNCHER="
if not defined PYEXE for /f "delims=" %%P in ('where python 2^>nul ^| findstr /v /i WindowsApps') do call :try "%%P"
exit /b 0

:try
if defined PYEXE exit /b 0
if "%~1"=="" exit /b 0
if not exist "%~1" exit /b 0
"%~1" -c "import requests, yaml, PIL" >nul 2>&1 && set "PYEXE=%~1"
exit /b 0
