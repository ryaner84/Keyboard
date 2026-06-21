@echo off
REM One-time, resumable keyboard history import from Geekhack board 70.
REM It runs only the Geekhack pass and leaves the normal nightly schedule unchanged.
call "%~dp0run-scraper.bat" --geekhack-backfill-year 2020 --budget-minutes 240
exit /b %ERRORLEVEL%
