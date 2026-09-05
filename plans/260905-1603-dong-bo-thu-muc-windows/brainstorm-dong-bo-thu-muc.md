# Đồng bộ thư mục Windows ↔ web — brainstorm & quyết định

**Ngày:** 05/09/2026 · **Trạng thái:** đã chốt thiết kế, CHƯA làm

## Vấn đề

Bản vẽ nằm trên máy chủ file công ty. Tải lên web phải bấm từng file qua trình
duyệt. Muốn thả file vào thư mục là xong.

## Ràng buộc phát hiện lúc scout

**Tên file thật KHÔNG nằm trên S3.** Key là `bim/2026-09/<12hex>.pdf`; tên thật
(`QUYỂN I.1-2 CỌC KHOAN NHỒI…pdf`) nằm ở MongoDB và ở `Content-Disposition` của
object. → **Mọi cách mount S3 thành ổ đĩa (rclone, TntDrive, `aws s3 sync`) đều
cho ra thư mục toàn tên hex, phẳng, không cây WBS.** Đây lại là cách Google trả về
đầu tiên. Muốn thư mục đọc được thì bắt buộc đi qua MongoDB.

Quy mô: 47 dòng · 32 file · 624 MB.

## Quyết định

> **Đổi hướng giữa buổi:** ban đầu chốt chạy trong trình duyệt (File System Access
> API). Khi biết kho là **ổ NAS** chứ không phải máy chủ chạy được app, đã chuyển
> sang **script Node chạy trên một máy trạm trỏ vào NAS**. Lý do ở § So sánh hai hướng.

| Câu hỏi | Chốt |
|---|---|
| Mục đích | Khỏi tải lên tay (thư mục → web) |
| Nơi chạy | **Script Node** trên máy trạm, trỏ vào đường dẫn NAS |
| Cách chạy | Chạy tay trước (`.bat`); cắm Task Scheduler 15 phút sau |
| Thư mục gốc | Dựng ngay trong thư mục bản vẽ hiện có, cây cũ giữ nguyên |
| Mật khẩu | `.env` cạnh script, **chỉ `EDIT_KEY`** — script không xoá nên không cần `ADMIN_KEY` |
| Cây thư mục | **Web tự tạo** khớp cây WBS — không dùng cây có sẵn |
| Khớp thư mục ↔ dòng | File ẩn `.bim-id` trong mỗi thư mục dòng (bất biến) |
| File → cột nào | Thư mục con theo cột: PDF · DWG-Excel · TVGS · Da duyet · Chap thuan |
| Nhận diện trùng | Tên file + dung lượng |
| Chiều | **Hai chiều**, nhưng KHÔNG BAO GIỜ tự xoá |
| Khi file biến mất | Sổ ghi `.bim-sync.json` → chỉ BÁO, người quyết |
| Quyền | **Chỉ quản trị.** Không làm cơ chế xin/cấp quyền |

### Vì sao web tự tạo cây thay vì đọc cây có sẵn

Tên thư mục do máy sinh → khớp chính xác 100%, không đoán mò. Vòng khép kín:
máy tạo thư mục → người thả file → máy đọc lại đúng thư mục đó.

### Vì sao cần sổ ghi

Đồng bộ hai chiều mà chỉ nhìn hai bên tại một thời điểm thì không phân biệt được:

- File có trên bảng, không có trong thư mục = *chưa tải về* hay *đã bị xoá khỏi thư mục*?
- File có trong thư mục, không trên bảng = *bản vẽ mới* hay *vừa bị xoá trên web*?

Trường hợp thứ hai nguy hiểm: không có sổ ghi thì file xoá trên web sẽ **sống lại**
từ thư mục ở mỗi lần đồng bộ. `.bim-sync.json` lưu "lần trước thấy gì", so ba chiều:
lần trước × thư mục bây giờ × bảng bây giờ.

## Cấu trúc sinh ra

```
Z:\Ban ve SBGB\
├─ .bim-sync.json                          mã kế hoạch + sổ ghi lần trước
├─ 1 PHAN I - CAC BAN VE PHAN CAU\
│  └─ 1.1 TAP I - PHAN CAU CHINH TUYEN\
│     └─ 1.1.1 COC KHOAN NHOI\
│        └─ 1.1.1.1 QUYEN I.1-1 - COC KHOAN NHOI\
│           ├─ .bim-id                      row.id, bất biến
│           ├─ PDF\  DWG-Excel\  TVGS\  Da duyet\  Chap thuan\
```

Thư mục con cột **chỉ tạo cho dòng lá** (~30 dòng × 5 = 150), không tạo cho dòng
cha. Mã WBS đứng đầu để Explorer tự xếp đúng thứ tự.

## Ba việc web làm

1. **Dựng cây** — tạo thư mục thiếu, ghi `.bim-id`. Thư mục có `.bim-id` khớp một
   dòng thì **đổi tên theo** khi tên hạng mục đổi → đổi tên trên web không đứt liên kết.
2. **Quét & đẩy** — so từng thư mục cột với mảng tương ứng, đẩy file thiếu qua
   `sign-upload → PUT S3 → confirm`. Ghi bảng **theo từng dòng**, không gom cả mẻ.
3. **Kéo về** — file có trên bảng mà thư mục chưa có thì tải xuống.

Báo cáo cuối: đã lên N · đã về M · bỏ qua K · **thư mục không khớp dòng nào** ·
**file từng đồng bộ nay biến mất một bên** (chờ người quyết).

## So sánh hai hướng

| | Trình duyệt (FSA API) | **Script Node (đã chọn)** |
|---|---|---|
| Ổ NAS | Chưa kiểm chứng được — **rủi ro chặn cả hướng** | Chạy thẳng bằng UNC hoặc ổ map |
| Đường dẫn > 260 ký tự | Không xử lý được | Tiền tố `\\?\` |
| Tự động | Không thể — phải mở trang bấm nút | Task Scheduler |
| Đụng `bang-hang-muc.html` | Có → phải chờ phiên khác xong | **Không đụng file nào của ai** |
| Cài đặt | Không cần gì | Cài Node trên máy chạy |
| Quyền thư mục | Phải xin lại mỗi phiên | Không cần |

Yếu tố quyết định: kho là **NAS**, không phải máy chủ chạy được app. Hướng trình
duyệt đứng trên một giả định chưa kiểm chứng được; hướng Node thì không.

## Rủi ro

| Rủi ro | Mức | Xử lý |
|---|---|---|
| **Máy chạy phải bật** — NAS không tự chạy được script | Cao | Bản chạy tay không vướng; cắm lịch thì chọn máy luôn bật |
| Hai máy cùng cắm lịch → tải lên trùng | Cao | File khoá trên NAS, tự hết hạn 30 phút; nguyên tắc chỉ MỘT máy cắm lịch |
| **File đang copy dở** vào NAS bị đọc phải | Cao | Bỏ qua file sửa trong 60 giây; đọc kích thước hai lần cách vài giây |
| Đường dẫn Windows 260 ký tự | Trung bình | Tiền tố `\\?\`; vẫn cắt tên mỗi cấp ~40 ký tự |
| Ký tự cấm (`:` `/` trong tên hạng mục) | Chắc chắn xảy ra | Thay bằng `-`; tên thư mục không bao giờ giống hệt tên hạng mục |
| Cây mới lẫn với cây thư mục cũ | Trung bình | Script CHỈ đụng thư mục có `.bim-id`; thư mục lạ không đọc, không sửa |
| Đứt giữa chừng → file trên S3 chưa vào bảng | Trung bình | Ghi bảng theo từng dòng; `don-file-mo-coi.mjs` dọn phần sót |
| `.bim-id` bị xoá nhầm | Trung bình | Thư mục thành "không khớp dòng nào" → báo cáo, không đoán |
| `EDIT_KEY` nằm trên máy chung | Thấp | Chỉ quyền ghi, không có `ADMIN_KEY`; đặt quyền đọc file cho đúng tài khoản |

## Bước tiếp

Kế hoạch chi tiết: [plan.md](plan.md) — 4 pha.
