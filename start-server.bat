@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Chua cai Node.js.
  echo      Vao https://nodejs.org tai ban LTS, cai xong roi chay lai file nay.
  echo.
  pause
  exit /b
)
echo Dang khoi dong may chu... Giu cua so nay MO trong luc dung. Dong cua so = tat may chu.
echo.
node serve.cjs
echo.
echo (May chu da dung.)
pause
