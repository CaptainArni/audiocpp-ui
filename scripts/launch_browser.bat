@echo off
REM audio.cpp Studio - Launch in the default browser
REM Uses the local .venv. Does NOT build the frontend - run scripts\build.bat first if needed.
setlocal

pushd "%~dp0.."
set "VENV_PY=%CD%\.venv\Scripts\python.exe"

if not exist "%VENV_PY%" (
    echo ERROR: virtual environment not found at "%VENV_PY%"
    echo First-time setup:
    echo    python -m venv .venv
    echo    .venv\Scripts\python -m pip install -r backend\requirements.txt
    popd
    pause
    exit /b 1
)

echo Starting server... Press Ctrl+C to stop.
"%VENV_PY%" backend\browser_app.py
set EXITCODE=%ERRORLEVEL%

popd
if not "%EXITCODE%"=="0" pause
endlocal
