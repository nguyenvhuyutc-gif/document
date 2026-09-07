@echo off
chcp 65001 >nul
cd /d "%~dp0"
title GHI THAT - Dong bo thu muc NAS

REM File nay GHI THAT: tao thu muc, doi ten, day file len web, keo file ve NAS.
REM Muon xem truoc ma khong ghi gi thi bam dup dong-bo.bat (luon la chay kho).
REM
REM Van KHONG BAO GIO XOA gi, o ca hai ben - do la thiet ke cua script, khong
REM phai cua file .bat nay. Cai gi script khong tu quyet duoc thi no bao ra muc
REM "CAN BAN QUYET" va de nguyen.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Chua cai Node.js.
  echo      Vao https://nodejs.org tai ban LTS ^(20 tro len^), cai xong roi chay lai.
  echo.
  pause
  exit /b 1
)

if not exist "scripts\.env.dong-bo" (
  echo.
  echo  [!] Chua co file cau hinh scripts\.env.dong-bo
  echo      Chep mau roi dien vao:
  echo          copy scripts\.env.dong-bo.example scripts\.env.dong-bo
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo    GHI THAT - se thay doi thu muc tren NAS va file tren web
echo  ============================================================
echo.
echo    Truoc khi tiep tuc, dong Explorer va AutoCAD dang mo thu
echo    muc du an. Windows khoa thu muc dang mo, doi ten se hong.
echo.
set /p OK="  Go  y  roi Enter de chay that (bat ky phim nao khac = thoat): "
if /i not "%OK%"=="y" (
  echo.
  echo  Da huy, khong ghi gi.
  echo.
  pause
  exit /b 0
)

echo.
node "scripts\dong-bo-thu-muc.mjs" --thuc-hien
set MA=%ERRORLEVEL%

echo.
if not "%MA%"=="0" (
  echo  [!] Script dung voi ma loi %MA%. Doc phan tren de biet ly do.
) else (
  echo  Xong. Doc muc "DA LAM" o tren de biet script da thay doi nhung gi.
)
echo.
pause
exit /b %MA%
