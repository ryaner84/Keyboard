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
REM    1. terminates any leftover scraper instances (frees DB slot + profile lock)
REM    2. git-pulls the latest scrape.py from GitHub
REM    3. ensures Python + a venv + Playwright Chromium are installed
REM    4. (first run) asks for the Supabase connection + password, validates, saves
REM    5. registers the nightly 00:00 GMT+8 schedule (re-registers every run so
REM       it self-corrects across DST changes)
REM    6. runs the scraper, logging to scraper\logs\
REM ===========================================================================
setlocal EnableDelayedExpansion

REM ---------------------------------------------------------------------------
REM  Config: where to clone, and the repo URL.
REM ---------------------------------------------------------------------------
set "REPO_URL=https://github.com/ryaner84/Keyboard.git"
set "CLONE_DIR=C:\ryaner84\gmk-tracker"

REM Windows Defender often holds .git pack files open right after a pull, making
REM git's cleanup ask "Unlink of file ... failed. Should I try again? (y/n)" -
REM which would hang an unattended scheduled run forever. GIT_ASK_YESNO=false
REM makes git auto-answer "no" (the stale pack file is harmless and gets cleaned
REM up on a later run), and gc.auto=0 on pulls skips the repack entirely.
set "GIT_ASK_YESNO=false"

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
    REM Some WorkSpace images leave .git\logs owned by the account that created
    REM the clone. Disabling reflog writes lets a normal fast-forward update
    REM proceed without needing to take ownership of the whole checkout.
    git -C "%CLONE_DIR%" -c gc.auto=0 -c core.logAllRefUpdates=false pull --ff-only origin main
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
call "%CLONE_DIR%\scraper\run-scraper.bat" %*
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

REM --- 1. Terminate any leftover scraper instances ----------------------------
REM Kills only python/chrome processes whose command line points inside THIS
REM scraper folder (its venv python running scrape.py), or Chromium using the
REM scraper profile under the scheduled account's Local AppData. Filtering by
REM process name means this script's own
REM cmd.exe/powershell.exe can never match, and your other Python apps are
REM untouched (different path). This frees the DB pooler slot and the browser
REM profile lock left behind by a force-closed run.
echo [run] Step 1: closing any previous scraper instances ...
set "KILL_MATCH=%SCRAPER%"
set "PROFILE_MATCH=%LOCALAPPDATA%\gmk-tracker\scraper-profile"
powershell -NoProfile -Command "$root=$env:KILL_MATCH; $profile=$env:PROFILE_MATCH; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and (($_.CommandLine -like ('*'+$root+'*')) -or ($_.CommandLine -like ('*'+$profile+'*')) -or ($_.CommandLine -like '*gmk-tracker-browser-profile-*')) -and ($_.Name -in @('python.exe','pythonw.exe','chrome.exe','headless_shell.exe')) } | ForEach-Object { Write-Host ('  closing PID '+$_.ProcessId+' ('+$_.Name+')'); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul
REM Give killed connections a moment to drop so the DB pooler frees the slot.
timeout /t 3 /nobreak >nul 2>&1

REM --- 2. Pull the latest scraper from GitHub --------------------------------
where git >nul 2>&1
if !ERRORLEVEL!==0 (
    echo [run] git pull origin main ...
    git -C "%REPO%" -c gc.auto=0 -c core.logAllRefUpdates=false pull --ff-only origin main
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

REM --- 3. Locate Python -------------------------------------------------------
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

REM --- 4. Virtual env + dependencies ------------------------------------------
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

REM --- 5. Register the nightly 00:00 GMT+8 schedule ---------------------------
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
    REM The scraper needs the user's interactive desktop, not administrator
    REM privileges. A per-user task name also avoids colliding with a task that
    REM was registered previously by another Windows account.
    set "TASK_NAME=GMK Scraper - %USERNAME%"
    schtasks /Create /TN "!TASK_NAME!" /TR "%SCRAPER%\run-scraper.bat" /SC DAILY /ST !LOCALTIME! /RU "%USERDOMAIN%\%USERNAME%" /IT /RL LIMITED /F
    if !ERRORLEVEL!==0 (
        echo [run] Task "!TASK_NAME!" scheduled daily at !LOCALTIME! local ^(= 00:00 GMT+8^).
    ) else (
        echo [run] WARNING: schtasks registration failed ^(continuing anyway^).
    )
) else (
    echo [run] WARNING: Could not determine GMT+8 time - schedule not registered.
)

REM --- 6. Run the scraper -----------------------------------------------------
echo [run] Launching scraper ^(logs in %SCRAPER%\logs^) ...
"%VENV_PY%" "%SCRAPER%\scrape.py" %*
set "RC=!ERRORLEVEL!"

echo.
echo [run] Finished with exit code !RC!.
if !RC! neq 0 (
    echo [run] Scraper reported an error. Check the log in %SCRAPER%\logs\
    pause
)
endlocal & exit /b %RC%
