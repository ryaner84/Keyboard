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
REM    4. registers the nightly 00:00 GMT+8 schedule (re-registers every run to
REM       self-correct across DST changes)
REM    5. runs the scraper, logging to scraper\logs\
REM ===========================================================================
setlocal EnableDelayedExpansion

REM --- Move to the repo root (this .bat lives in <repo>\scraper\) -------------
cd /d "%~dp0\.."
set "REPO=%CD%"
set "SCRAPER=%REPO%\scraper"

if not exist "!SCRAPER!\logs" mkdir "!SCRAPER!\logs"

echo ============================================================
echo  GMK Scraper  -  %DATE% %TIME%
echo  Repo: !REPO!
echo ============================================================

REM --- 1. Pull the latest scraper from GitHub --------------------------------
where git >nul 2>&1
if !ERRORLEVEL!==0 (
    echo [run] git pull origin main ...
    git -C "!REPO!" pull origin main
    if !ERRORLEVEL! neq 0 (
        echo [run] WARNING: git pull failed ^(exit code !ERRORLEVEL!^).
        echo [run]   If prompted for credentials, open a plain Command Prompt and run:
        echo [run]     git -C "!REPO!" pull origin main
        echo [run]   Sign in when prompted, then re-run this bat.
    )
) else (
    echo [run] WARNING: git not found on PATH - skipping pull ^(using local copy^).
)

REM --- Verify required files exist after pull ---------------------------------
if not exist "!SCRAPER!\requirements.txt" (
    echo.
    echo [run] ERROR: !SCRAPER!\requirements.txt not found.
    echo [run]   git pull likely needs credentials. Open a Command Prompt and run:
    echo [run]     git -C "!REPO!" pull origin main
    echo [run]   Then re-run this bat.
    pause
    exit /b 1
)
if not exist "!SCRAPER!\scrape.py" (
    echo.
    echo [run] ERROR: !SCRAPER!\scrape.py not found.
    echo [run]   Same fix: authenticate git and pull, then re-run.
    pause
    exit /b 1
)
if not exist "!SCRAPER!\schedule_time.py" (
    echo.
    echo [run] ERROR: !SCRAPER!\schedule_time.py not found.
    echo [run]   Same fix: authenticate git and pull, then re-run.
    pause
    exit /b 1
)

REM --- 2. Locate Python -------------------------------------------------------
set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY ( where py >nul 2>&1 && set "PY=py" )

if not defined PY (
    echo [run] Python not found. Attempting install via winget ...
    where winget >nul 2>&1
    if !ERRORLEVEL!==0 (
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
        where python >nul 2>&1 && set "PY=python"
        if not defined PY ( where py >nul 2>&1 && set "PY=py" )
    )
)
if not defined PY (
    echo [run] ERROR: Python is required but could not be found or installed.
    echo        Install Python 3.12 from https://www.python.org/downloads/ and re-run.
    pause
    exit /b 1
)
echo [run] Using Python: !PY!

REM --- 3. Virtual env + dependencies ------------------------------------------
if not exist "!SCRAPER!\.venv\Scripts\python.exe" (
    echo [run] Creating virtual environment ...
    "!PY!" -m venv "!SCRAPER!\.venv"
    if !ERRORLEVEL! neq 0 (
        echo [run] ERROR: Failed to create virtual environment.
        pause
        exit /b 1
    )
)
set "VENV_PY=!SCRAPER!\.venv\Scripts\python.exe"

echo [run] Installing/upgrading dependencies ...
"!VENV_PY!" -m pip install --quiet --upgrade pip
"!VENV_PY!" -m pip install --quiet -r "!SCRAPER!\requirements.txt"
if !ERRORLEVEL! neq 0 (
    echo [run] ERROR: pip install failed. Check requirements.txt and your network.
    pause
    exit /b 1
)
"!VENV_PY!" -m playwright install chromium

REM --- 4. Register the nightly 00:00 GMT+8 schedule ---------------------------
REM Always recompute the local trigger time so it self-corrects across DST.
for /f "usebackq delims=" %%T in (`"!VENV_PY!" "!SCRAPER!\schedule_time.py"`) do set "LOCALTIME=%%T"
if defined LOCALTIME (
    echo [run] 00:00 GMT+8 = !LOCALTIME! local time on this PC.
    REM /TR path — no inner quotes needed when path has no spaces.
    REM If your repo path has spaces, this will fail; move the repo to a path without spaces.
    schtasks /Create /TN "GMK Scraper" /TR "!SCRAPER!\run-scraper.bat" /SC DAILY /ST !LOCALTIME! /RL HIGHEST /F
    if !ERRORLEVEL!==0 (
        echo [run] Task "GMK Scraper" scheduled daily at !LOCALTIME! local ^(= 00:00 GMT+8^).
    ) else (
        echo [run] WARNING: schtasks registration failed.
        echo [run]   If your repo path contains spaces, try moving it to C:\gmk-tracker\
        echo [run]   The scraper will still run now but won't be scheduled.
    )
) else (
    echo [run] WARNING: Could not determine GMT+8 time - schedule not registered.
)

REM --- 5. Run the scraper -----------------------------------------------------
echo [run] Launching scraper ^(logs in !SCRAPER!\logs^) ...
"!VENV_PY!" "!SCRAPER!\scrape.py"
set "RC=!ERRORLEVEL!"

echo.
echo [run] Finished with exit code !RC!.
if !RC! neq 0 (
    echo [run] Scraper reported an error. Check the log in !SCRAPER!\logs\
    pause
)
endlocal & exit /b %RC%
