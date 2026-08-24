@echo off
REM ==============================================================================
REM Crowd Heatmap & Business Intelligence Platform - Windows Batch Launcher
REM ==============================================================================

setlocal

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

REM Virtual environment python resolution
if exist "%PROJECT_DIR%.venv\Scripts\python.exe" (
    set "PYTHON_EXEC=%PROJECT_DIR%.venv\Scripts\python.exe"
) else if exist "%PROJECT_DIR%venv\Scripts\python.exe" (
    set "PYTHON_EXEC=%PROJECT_DIR%venv\Scripts\python.exe"
) else (
    set "PYTHON_EXEC=python"
)

if "%1"=="" goto dev
if "%1"=="dev" goto dev
if "%1"=="start" goto dev
if "%1"=="run" goto dev
if "%1"=="server" goto dev
if "%1"=="setup" goto setup
if "%1"=="migrate" goto migrate
if "%1"=="test" goto test
if "%1"=="train" goto train
if "%1"=="superuser" goto superuser
if "%1"=="check" goto check
if "%1"=="clean" goto clean
if "%1"=="help" goto help

"%PYTHON_EXEC%" run.py %*
goto end

:dev
"%PYTHON_EXEC%" run.py dev %2 %3 %4 %5
goto end

:setup
"%PYTHON_EXEC%" run.py setup
goto end

:migrate
"%PYTHON_EXEC%" run.py migrate
goto end

:test
"%PYTHON_EXEC%" run.py test %2 %3 %4
goto end

:train
"%PYTHON_EXEC%" run.py train
goto end

:superuser
"%PYTHON_EXEC%" run.py superuser
goto end

:check
"%PYTHON_EXEC%" run.py check
goto end

:clean
"%PYTHON_EXEC%" run.py clean
goto end

:help
echo ======================================================================
echo   Crowd Heatmap & Business Intelligence Platform
echo ======================================================================
echo Available commands:
echo   run.bat                  Start full-stack dev server
echo   run.bat dev [--port N]   Start dev server on custom port
echo   run.bat setup            Install dependencies and run migrations
echo   run.bat migrate          Apply database migrations
echo   run.bat test             Run test suite
echo   run.bat train            Train recommendation model
echo   run.bat superuser        Create Django admin superuser
echo   run.bat check            Run Django configuration check
echo   run.bat clean            Clean bytecode cache
echo   run.bat help             Show this help menu
goto end

:end
endlocal
