@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Dong bo thu muc NAS - bang theo doi hang muc

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Chua cai Node.js.
  echo      Vao https://nodejs.org tai ban LTS ^(20 tro len^), cai xong roi chay lai file nay.
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

if not exist "scripts\dong-bo-thu-muc.mjs" (
  echo.
  echo  [!] Thieu scripts\dong-bo-thu-muc.mjs - ban chep thieu file.
  echo      Chep lai ca thu muc scripts\ tu ban goc.
  echo.
  pause
  exit /b 1
)

REM Khong ghi san --thuc-hien o day. Bam dup file nay LUON la chay kho:
REM chi in ra viec se lam, khong dung toi NAS lan web. Muon ghi that thi mo
REM Command Prompt va go:   dong-bo.bat --thuc-hien
echo.
if "%~1"=="" (
  echo  CHAY KHO - chi in ra viec se lam, khong ghi gi len NAS lan web.
  echo  Muon ghi that: mo Command Prompt va go   dong-bo.bat --thuc-hien
) else (
  echo  Tham so: %*
)
echo.

node "scripts\dong-bo-thu-muc.mjs" %*
set MA=%ERRORLEVEL%

echo.
if not "%MA%"=="0" (
  echo  [!] Script dung voi ma loi %MA%. Doc phan tren de biet ly do.
) else (
  echo  Xong.
)
echo.
pause
exit /b %MA%
