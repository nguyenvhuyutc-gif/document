@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Dang ky nut "mo trong Explorer"

REM Dang ky giao thuc bim:// cho TAI KHOAN NAY (HKEY_CURRENT_USER), khong can
REM quyen admin. Sau khi chay, nut "mo trong Explorer" tren trang web se mo duoc
REM file nam tren o mang.
REM
REM Go bo: chay lai file nay voi tham so /go
REM     dang-ky-mo-file.bat /go

set "PS1=%~dp0scripts\mo-file-tren-may.ps1"
set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if /i "%~1"=="/go" goto GOBO

if not exist "%PS1%" (
  echo.
  echo  [!] Thieu file scripts\mo-file-tren-may.ps1
  echo      Ban chep thieu - chep lai ca thu muc scripts\ tu ban goc.
  echo.
  pause
  exit /b 1
)

echo.
echo  Dang ky giao thuc bim:// cho tai khoan %USERNAME%
echo  Script duoc goi: %PS1%
echo.

reg add "HKCU\Software\Classes\bim" /ve /t REG_SZ /d "URL:BIM mo file tren may" /f >nul
reg add "HKCU\Software\Classes\bim" /v "URL Protocol" /t REG_SZ /d "" /f >nul
reg add "HKCU\Software\Classes\bim\DefaultIcon" /ve /t REG_SZ /d "%SystemRoot%\System32\shell32.dll,3" /f >nul
reg add "HKCU\Software\Classes\bim\shell\open\command" /ve /t REG_SZ /d "\"%PSEXE%\" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%PS1%\" \"%%1\"" /f >nul

if errorlevel 1 (
  echo  [!] Ghi registry that bai.
  echo.
  pause
  exit /b 1
)

echo  Xong.
echo.
echo  Bay gio mo https://bvtc.vcijsc.com, bam nut hinh thu muc canh mot file.
echo  Lan dau trinh duyet se hoi "Mo Windows PowerShell?" - chon Mo.
echo.
echo  LUU Y: file nay dang ky duong dan
echo      %~dp0
echo  Chuyen thu muc du an di cho khac thi phai chay lai file nay.
echo.
pause
exit /b 0

:GOBO
echo.
echo  Go dang ky giao thuc bim:// ...
reg delete "HKCU\Software\Classes\bim" /f >nul 2>nul
echo  Xong. Nut "mo trong Explorer" tren web se khong con tac dung.
echo.
pause
exit /b 0
