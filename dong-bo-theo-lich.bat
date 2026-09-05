@echo off
REM ============================================================
REM  Ban dung cho Task Scheduler - KHONG co pause, KHONG cho bam phim.
REM  Bam dup file nay se chay THAT (co --thuc-hien). Muon xem thu thi
REM  dung dong-bo.bat chu khong phai file nay.
REM
REM  Ghi log ra nhat-ky\dong-bo-YYYY-MM-DD.log, moi ngay mot file.
REM  Ma thoat cua script duoc giu nguyen de Task Scheduler bao dung/sai.
REM ============================================================
chcp 65001 >nul
cd /d "%~dp0"

if not exist "nhat-ky" mkdir "nhat-ky"

REM Ngay theo dinh dang YYYY-MM-DD, khong phu thuoc dinh dang ngay cua may.
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set NGAY=%%i
set LOG=nhat-ky\dong-bo-%NGAY%.log

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format 'HH:mm:ss'"') do set GIO=%%i
echo. >> "%LOG%"
echo ==== %NGAY% %GIO% ==== >> "%LOG%"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Khong tim thay Node.js trong PATH cua tai khoan chay tac vu. >> "%LOG%"
  exit /b 1
)

node "scripts\dong-bo-thu-muc.mjs" --thuc-hien >> "%LOG%" 2>&1
set MA=%ERRORLEVEL%
echo ---- ket thuc, ma thoat %MA% ---- >> "%LOG%"

REM Don log cu hon 60 ngay.
powershell -NoProfile -Command "Get-ChildItem 'nhat-ky\dong-bo-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-60) } | Remove-Item -Force" 2>nul

exit /b %MA%
