:: ── Load current version ────────────────────────────
:: Read build-config.json from the frontend dir. We pushd there and use a
:: RELATIVE path so no backslashes ever reach the JS string (backslashes are
:: escape characters in JS and mangled the old absolute path, e.g. \U, \f,
:: \O). The result is written to a temp file and read back with for /f —
:: reading a file is far more reliable than cmd's backtick command
:: substitution, which chokes on the parens/quotes in an inline node command.
pushd "%FRONTEND_DIR%" 2>nul
node -e "const c=require('fs').readFileSync('build-config.json','utf-8');const j=JSON.parse(c);console.log(j.version+','+j.productName);" > "%TEMP%\aichat-ver.tmp" 2>nul
popd 2>nul
for /f "usebackq tokens=1,2 delims=," %%a in ("%TEMP%\aichat-ver.tmp") do (
    set "CURRENT_VER=%%a"
    set "APP_NAME=%%b"
)
del "%TEMP%\aichat-ver.tmp" 2>nul
if not defined CURRENT_VER set "CURRENT_VER=1.0.0"
if not defined APP_NAME set "APP_NAME=Kasalix AI Chat"

cls
