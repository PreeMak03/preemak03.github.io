@echo off
cd /d "%~dp0"
echo.
echo  Tesla Active Sound — local server
echo  Open on this PC or Tesla Browser:
echo.
where py >nul 2>nul && (
  for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1 -ExpandProperty IPAddress)"') do set IP=%%i
  echo  http://localhost:8765
  if defined IP echo  http://%IP%:8765
  echo.
  py -m http.server 8765
  goto :eof
)
where python >nul 2>nul && (
  echo  http://localhost:8765
  echo.
  python -m http.server 8765
  goto :eof
)
echo  Python not found. Opening folder — use any static server, or VS Code Live Server.
start "" "%~dp0"
pause
