# ============================================================
#  mo-file-tren-may.ps1 — mở một file trong Explorer khi người dùng bấm nút
#  "mở trong Explorer" trên https://bvtc.vcijsc.com
#
#  Windows gọi file này qua giao thức bim:// đã đăng ký (dang-ky-mo-file.bat).
#  Đối số nhận được có dạng:  bim://%5C%5Cnas%5C...%5Cban-ve.pdf
#
#  ĐÂY LÀ ĐIỂM TRANG WEB GỌI VÀO MÁY. Chuỗi đưa vào do trang web dựng nên, nên
#  coi nó là dữ liệu KHÔNG TIN ĐƯỢC:
#    · không Invoke-Expression, không & $chuoi, không ghép vào lệnh shell
#    · chỉ gọi đúng explorer.exe, và truyền đường dẫn qua ArgumentList
#    · chặn ký tự điều khiển và mọi thứ không phải đường dẫn
#  Kịch bản xấu nhất nếu ai đó lừa được: Explorer mở nhầm một thư mục. Không có
#  đường nào từ đây chạy được chương trình do web chỉ định.
# ============================================================
param([string]$Uri = "")

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# BIM_MO_FILE_IM=1 → in ra thay vì hiện hộp thoại. Dùng cho bài kiểm và cho máy
# chạy không có màn hình; hộp thoại ở đó treo vô hạn chờ một cú bấm không ai bấm.
function Bao($loi, $tieuDe = "Mở file trên máy") {
  if ($env:BIM_MO_FILE_IM -eq "1") { Write-Output $loi; return }
  try { [System.Windows.Forms.MessageBox]::Show($loi, $tieuDe) | Out-Null } catch { Write-Output $loi }
}

if (-not $Uri) { Bao "Không nhận được đường dẫn nào."; exit 1 }

# bim://<đường dẫn đã mã hoá>  — chấp nhận cả dạng có và không có dấu / sau bim:
$s = $Uri -replace '^(?i)bim:(//)?', ''
$s = $s.TrimEnd('/')
try { $s = [System.Uri]::UnescapeDataString($s) } catch { Bao "Đường dẫn hỏng, không giải mã được."; exit 1 }
$s = $s -replace '/', '\'

if (-not $s) { Bao "Đường dẫn rỗng."; exit 1 }

# Ký tự điều khiển và các ký tự Windows không cho phép trong tên. Dấu ':' và '\'
# vẫn phải cho qua vì chúng nằm trong "Z:\..." và "\\nas\...".
if ($s -match '[\x00-\x1F]' -or $s -match '[<>|?*"]') { Bao "Đường dẫn chứa ký tự không hợp lệ:`n`n$s"; exit 1 }
if ($s -match '(^|\\)\.\.(\\|$)') { Bao "Đường dẫn chứa '..' nên bị từ chối:`n`n$s"; exit 1 }

# Phải là đường dẫn tuyệt đối: ổ đĩa (Z:\) hoặc UNC (\\máy\chia-sẻ).
if (-not ($s -match '^[A-Za-z]:\\' -or $s -match '^\\\\[^\\]+\\')) {
  Bao "Đây không phải đường dẫn tuyệt đối:`n`n$s"
  exit 1
}

# File có thật → mở Explorer và CHỌN SẴN nó. Không có thì lùi về thư mục cha, vì
# thường là file vừa đổi tên hoặc chưa đồng bộ về — mở đúng thư mục vẫn có ích hơn
# là báo lỗi rồi thôi.
if (Test-Path -LiteralPath $s) {
  Start-Process explorer.exe -ArgumentList "/select,`"$s`""
  exit 0
}

# GetDirectoryName chứ không Split-Path: trong PowerShell 5.1 thì -LiteralPath và
# -Parent thuộc hai bộ tham số xung đột nhau, mà bỏ -LiteralPath là đường dẫn có
# "[" hay "]" bị đọc thành ký tự đại diện.
$cha = [System.IO.Path]::GetDirectoryName($s)
if ($cha -and (Test-Path -LiteralPath $cha)) {
  Start-Process explorer.exe -ArgumentList "`"$cha`""
  Bao "Không thấy file:`n`n$([System.IO.Path]::GetFileName($s))`n`nĐã mở thư mục chứa nó. Có thể file chưa được kéo về máy — chạy đồng bộ rồi thử lại."
  exit 0
}

Bao "Không mở được:`n`n$s`n`nKiểm hai thứ: đã đăng nhập vào ổ mạng chưa, và thư mục gốc khai trên web có đúng máy này không (giữ Ctrl khi bấm nút để khai lại)."
exit 1
