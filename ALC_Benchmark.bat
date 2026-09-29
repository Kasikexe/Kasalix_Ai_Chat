@echo off
REM ===========================================================================
REM  ALC Benchmark - measure whether the Advanced Learning Cycle actually helps.
REM
REM  Double-click this, or run it from a terminal. It opens a menu:
REM    1) FULL TEST      every question, documentation + web search, ALC off vs ALC on
REM    2) customise a test   pick the fact set, the arms and what to search
REM    3) results in the browser (charts, click a run, compare any two)
REM    4) previous results in the terminal
REM    5) compare two runs in the terminal
REM    6) quit
REM
REM  A test measures two things - ALC off (the baseline) and ALC on (the cycle as
REM  it ships) - so each run is ONE number with something to read it against. The
REM  diagnostic arms are offered only if you ask for them.
REM
REM  FULL TEST IN ONE COMMAND (no menu):
REM    ALC_Benchmark.bat --full
REM  It asks for your Tavily API key so web search works. The key is asked for
REM  EVERY time and is never saved: it is not written into the results, and it is
REM  removed from the run's own scratch files when the run finishes. Press Enter at
REM  the prompt to run without web search instead.
REM
REM  Extra arguments are passed straight to the CLI, e.g.
REM    ALC_Benchmark.bat --list
REM    ALC_Benchmark.bat --full
REM    ALC_Benchmark.bat --dashboard --open
REM    ALC_Benchmark.bat --show "ALC v2"
REM    ALC_Benchmark.bat --compare "ALC v2" "ALC v3"
REM    ALC_Benchmark.bat --run --tag kasalix-1.0 --model kasalix:1.0
REM
REM  Requires: the backend virtualenv (backend\.venv) and a running Ollama.
REM ===========================================================================
setlocal

chcp 65001 >nul 2>&1
cd /d "%~dp0backend"

REM The backend venv first (that is where the dependencies are), then whatever
REM python is on PATH. `where` is deliberately not used for the venv path: it does
REM not resolve a relative path containing a separator, so it reports a venv that
REM is right there as missing.
set "PY="
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo.
  echo   Python was not found. Expected "%CD%\.venv\Scripts\python.exe"
  echo   Create it first:  python -m venv .venv  ^&^&  .venv\Scripts\pip install -r requirements.txt
  echo.
  pause
  exit /b 1
)

"%PY%" -m tests.eval.benchmark %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   The benchmark exited with code %CODE%.
)

REM Keep the window open when the script was started by a double-click. Use the
REM absolute path to Windows' find.exe: an msys/Git-Bash install on PATH shadows it
REM with a Unix `find`, which would walk the whole drive looking for `/c`.
echo %CMDCMDLINE% | "%SystemRoot%\System32\find.exe" /i "/c" >nul && pause
endlocal
