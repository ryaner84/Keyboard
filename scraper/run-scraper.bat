@echo off
REM ===========================================================================
REM  GMK Scraper launcher (Windows AWS WorkSpace)
REM
REM  Double-click this file to run the scraper now. It also runs nightly via
REM  Windows Task Scheduler (registered automatically on the first run).
REM
REM  Each run it:
REM    1. git-pulls the latest scrape.py from GitHub (so editing the .py in the
REM       repo is all you need to change scraping behaviour)
REM    2. ensures Python + a venv + Playwright Chromium are installed
REM    3. (first run) asks for the Supabase DB password, validates it, saves it
REM    4. (first run) registers the nightly 00:00 GMT+8 schedule
REM    5. runs the scraper, logging to scraper\logs\
REM ===========================================================================
setlocal EnableDelayedExpansion

REM --- Move to the repo root (this .bat lives in <repo>\scraper\) -------------
cd /d "%~dp0\.."
set "REPO=%CD%"
set "SCRAPER=%REPO%\scraper"

if not exist "%SCRAPER%\logs" mkdir "%SCRAPER%\logs"

echo ============================================================
echo  GMK Scraper  -  %DATE% %TIME%
echo  Repo: %REPO%
echo ============================================================

REM --- 1. Pull the latest scraper from GitHub --------------------------------
where git >nul 2>&1
if %ERRORLEVEL%==0 (
    echo [run] git pull origin main ...
    git pull origin main
) else (
    echo [run] WARNING: git not found on PATH - skipping pull ^(using local copy^).
)

REM --- 2. Locate Python ------------------------------------------------------
set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY ( where py >nul 2>&1 && set "PY=py" )

if not defined PY (
    echo [run] Python not found. Attempting install via winget ...
    where winget >nul 2>&1
    if !ERRORLEVEL!==0 (
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
        REM winget updates PATH for new shells; re-resolve for this session.
        where python >nul 2>&1 && set "PY=python"
        if not defined PY ( where py >nul 2>&1 && set "PY=py" )
    )
)
if not defined PY (
    echo [run] ERROR: Python is required but could not be found or installed.
    echo        Install Python 3.12 from https://www.python.org/downloads/ and re-run.
    exit /b 1
)
echo [run] Using Python: !PY!

REM --- 3. Virtual env + dependencies -----------------------------------------
if not exist "%SCRAPER%\.venv\Scripts\python.exe" (
    echo [run] Creating virtual environment ...
    !PY! -m venv "%SCRAPER%\.venv"
)
set "VENV_PY=%SCRAPER%\.venv\Scripts\python.exe"

echo [run] Installing/upgrading dependencies ...
"%VENV_PY%" -m pip install --quiet --upgrade pip
"%VENV_PY%" -m pip install --quiet -r "%SCRAPER%\requirements.txt"
"%VENV_PY%" -m playwright install chromium

REM --- 4. Register the nightly 00:00 GMT+8 schedule (first run only) ----------
schtasks /Query /TN "GMK Scraper" >nul 2>&1
if not %ERRORLEVEL%==0 (
    echo [run] Registering nightly schedule ...
)
REM Always recompute the local trigger time so it self-corrects across DST.
for /f "usebackq delims=" %%T in (`"%VENV_PY%" "%SCRAPER%\schedule_time.py"`) do set "LOCALTIME=%%T"
if defined LOCALTIME (
    echo [run] 00:00 GMT+8 = %LOCALTIME% local time on this PC.
    schtasks /Create /TN "GMK Scraper" /TR "\"%SCRAPER%\run-scraper.bat\"" /SC DAILY /ST %LOCALTIME% /RL HIGHEST /F >nul 2>&1
    if !ERRORLEVEL!==0 (
        echo [run] Task "GMK Scraper" scheduled daily at %LOCALTIME% local ^(= 00:00 GMT+8^).
    ) else (
        echo [run] WARNING: could not register the scheduled task ^(continuing anyway^).
    )
)

REM --- 5. Run the scraper ----------------------------------------------------
REM scrape.py prints to the console AND appends to scraper\logs\ itself, so the
REM exit code below is the scraper's own (not a pipe's).
echo [run] Launching scraper ^(logs in %SCRAPER%\logs^) ...
"%VENV_PY%" "%SCRAPER%\scrape.py"
set "RC=%ERRORLEVEL%"

echo [run] Finished with exit code %RC%.
endlocal & exit /b %RC%
