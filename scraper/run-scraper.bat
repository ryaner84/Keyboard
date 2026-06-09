@echo off
REM ===========================================================================
REM  GMK Scraper launcher (Windows AWS WorkSpace)  -  SELF-BOOTSTRAPPING
REM
REM  You can drop THIS FILE ANYWHERE and double-click it. On first run it will
REM  clone the whole repo from GitHub into a fixed folder, then run from there.
REM  On later runs it just git-pulls the latest code and runs.
REM
REM  Each run it:
REM    0. (bootstrap) if not already inside a clone, clone the repo and re-launch
REM    1. git-pulls the latest scrape.py from GitHub
REM    2. ensures Python + a venv + Playwright Chromium are installed
REM    3. (first run) asks for the Supabase DB password, validates it, saves it
REM    4. registers the nightly 00:00 GMT+8 schedule (re-registers every run so
REM       it self-corrects across DST changes)
REM    5. runs the scraper, logging to scraper\logs\
REM ===========================================================================
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------------------
REM  Config: where to clone, and the repo URL.
REM ---------------------------------------------------------------------------
set "REPO_URL=https://github.com/ryaner84/Keyboard.git"
set "CLONE_DIR=C:\ryaner84\gmk-tracker"

REM ---------------------------------------------------------------------------
REM  STEP 0 - Bootstrap. Are we already inside the cloned repo?
REM  We check whether <this-bat-dir>\..\.git exists (i.e. we live in <repo>\scraper).
REM ---------------------------------------------------------------------------
set "SELF_DIR=%~dp0"
if "%SELF_DIR:~-1%"=="\" set "SELF_DIR=%SELF_DIR:~0,-1%"

REM Check the parent of where this bat lives for a .git folder.
for %%I in ("%SELF_DIR%\..") do set "MAYBE_REPO=%%~fI"

if exist "%MAYBE_REPO%\.git" (
    REM We're already inside a clone - use it.
    set "REPO=%MAYBE_REPO%"
    goto :have_repo
)

REM --- Not inside a clone. We need to clone (or reuse an existing clone). ------
echo ============================================================
echo  GMK Scraper  -  first-time setup
echo ============================================================
echo [boot] This copy isn't inside the repo. Setting up at:
echo [boot]   %CLONE_DIR%

where git >nul 2>&1
if not !ERRORLEVEL!==0 (
    echo.
    echo [boot] ERROR: git is not installed.
    echo [boot]   Install Git for Windows from https://git-scm.com/download/win
    echo [boot]   then double-click this file again.
    pause
    exit /b 1
)

if exist "%CLONE_DIR%\.git" (
    echo [boot] Clone already exists - pulling latest ...
    git -C "%CLONE_DIR%" pull origin main
) else (
    echo [boot] Cloning %REPO_URL% ...
    git clone "%REPO_URL%" "%CLONE_DIR%"
)

if not exist "%CLONE_DIR%\scraper\run-scraper.bat" (
    echo.
    echo [boot] ERROR: clone did not produce %CLONE_DIR%\scraper\run-scraper.bat
    echo [boot]   If you were asked for credentials and it failed, the repo may be
    echo [boot]   private - sign in to GitHub via Git Credential Manager, then retry.
    echo [boot]   You can also clone manually:
    echo [boot]     git clone %REPO_URL% "%CLONE_DIR%"
    pause
    exit /b 1
)

echo [boot] Setup complete. Launching the real scraper from the clone ...
echo.
REM Hand off to the canonical copy inside the clone. It will detect it IS inside
REM a repo and run normally (no infinite loop).
call "%CLONE_DIR%\scraper\run-scraper.bat"
exit /b %ERRORLEVEL%

:have_repo
REM ---------------------------------------------------------------------------
REM  We are inside the clone. REPO is set. Proceed.
REM ---------------------------------------------------------------------------
set "SCRAPER=%REPO%\scraper"
if not exist "%SCRAPER%\logs" mkdir "%SCRAPER%\logs"

echo ============================================================
echo  GMK Scraper  -  %DATE% %TIME%
echo  Repo: %REPO%
echo ============================================================

REM --- 1. Pull the latest scraper from GitHub --------------------------------
where git >nul 2>&1
if !ERRORLEVEL!==0 (
    echo [run] git pull origin main ...
    git -C "%REPO%" pull origin main
    if !ERRORLEVEL! neq 0 (
        echo [run] WARNING: git pull failed - using local copy.
        echo [run]   If prompted for credentials, run from a Command Prompt:
        echo [run]     git -C "%REPO%" pull origin main
    )
) else (
    echo [run] WARNING: git not found on PATH - skipping pull ^(using local copy^).
)

REM --- Verify required files exist --------------------------------------------
if not exist "%SCRAPER%\requirements.txt" (
    echo [run] ERROR: %SCRAPER%\requirements.txt missing. Try: git -C "%REPO%" pull origin main
    pause
    exit /b 1
)
if not exist "%SCRAPER%\scrape.py" (
    echo [run] ERROR: %SCRAPER%\scrape.py missing. Try: git -C "%REPO%" pull origin main
    pause
    exit /b 1
)
if not exist "%SCRAPER%\schedule_time.py" (
    echo [run] ERROR: %SCRAPER%\schedule_time.py missing. Try: git -C "%REPO%" pull origin main
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
if not exist "%SCRAPER%\.venv\Scripts\python.exe" (
    echo [run] Creating virtual environment ...
    "!PY!" -m venv "%SCRAPER%\.venv"
    if !ERRORLEVEL! neq 0 (
        echo [run] ERROR: Failed to create virtual environment.
        pause
        exit /b 1
    )
)
set "VENV_PY=%SCRAPER%\.venv\Scripts\python.exe"

echo [run] Installing/upgrading dependencies ...
"%VENV_PY%" -m pip install --quiet --upgrade pip
"%VENV_PY%" -m pip install --quiet -r "%SCRAPER%\requirements.txt"
if !ERRORLEVEL! neq 0 (
    echo [run] ERROR: pip install failed. Check requirements.txt and your network.
    pause
    exit /b 1
)
"%VENV_PY%" -m playwright install chromium

REM --- 4. Register the nightly 00:00 GMT+8 schedule ---------------------------
REM Compute the local time via schedule_time.py, writing to a temp file. The
REM for /f "usebackq" form chokes when the command starts with a quoted path
REM ("filename syntax incorrect"), so we use a temp file instead - bulletproof.
set "SCHED_TMP=%TEMP%\gmk_sched_time.txt"
set "LOCALTIME="
"%VENV_PY%" "%SCRAPER%\schedule_time.py" > "%SCHED_TMP%" 2>nul
if exist "%SCHED_TMP%" (
    set /p LOCALTIME=<"%SCHED_TMP%"
    del "%SCHED_TMP%" >nul 2>&1
)
if defined LOCALTIME (
    echo [run] 00:00 GMT+8 = !LOCALTIME! local time on this PC.
    schtasks /Create /TN "GMK Scraper" /TR "%SCRAPER%\run-scraper.bat" /SC DAILY /ST !LOCALTIME! /RL HIGHEST /F
    if !ERRORLEVEL!==0 (
        echo [run] Task "GMK Scraper" scheduled daily at !LOCALTIME! local ^(= 00:00 GMT+8^).
    ) else (
        echo [run] WARNING: schtasks registration failed ^(continuing anyway^).
    )
) else (
    echo [run] WARNING: Could not determine GMT+8 time - schedule not registered.
)

REM --- 5. Run the scraper -----------------------------------------------------
echo [run] Launching scraper ^(logs in %SCRAPER%\logs^) ...
"%VENV_PY%" "%SCRAPER%\scrape.py"
set "RC=!ERRORLEVEL!"

echo.
echo [run] Finished with exit code !RC!.
if !RC! neq 0 (
    echo [run] Scraper reported an error. Check the log in %SCRAPER%\logs\
    pause
)
endlocal & exit /b %RC%
