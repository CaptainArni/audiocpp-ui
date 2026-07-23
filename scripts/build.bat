@echo off
REM Build script for audio.cpp Studio
REM Builds the frontend and copies to backend/static for serving

echo ======================================
echo Building audio.cpp Studio Frontend
echo ======================================

cd /d "%~dp0\..\frontend"

echo.
echo Installing npm dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    exit /b 1
)

echo.
echo Building frontend...
call npm run build
if errorlevel 1 (
    echo ERROR: npm build failed
    exit /b 1
)

echo.
echo Copying build to backend/static...
if exist "..\backend\static" (
    rmdir /s /q "..\backend\static"
)
xcopy /e /i /y "dist\*" "..\backend\static\"

echo.
echo ======================================
echo Build completed successfully!
echo Frontend files are in backend/static
echo ======================================
