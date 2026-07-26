@echo off
rem CashSync launcher (production build, port 3004)
rem Phone URL: https://node.tail41e069.ts.net:8448
cd /d C:\Users\daito\projects\cashsync
echo === CashSync starting on http://localhost:3004 ===
"C:\Program Files\nodejs\node.exe" "C:\Users\daito\projects\cashsync\node_modules\next\dist\bin\next" start -p 3004
