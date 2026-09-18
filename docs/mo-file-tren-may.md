# Nút "mở trong Explorer"

Cạnh mỗi file trên bảng có nút hình thư mục. Bấm là Explorer mở ra đúng chỗ file
nằm trên ổ mạng, file được chọn sẵn.

Nút chỉ hiện khi **hai điều kiện** cùng đúng:

- bạn đã đăng nhập quyền **sửa** hoặc **quản trị** — khách chỉ xem không thấy nút,
  và cũng không nhận được đường dẫn trong dữ liệu tải về;
- file đã qua **ít nhất một lần đồng bộ** — script mới là thứ biết file nằm ở đâu.
  File vừa tải thẳng lên web chưa có nút, chạy `dong-bo-ghi-that.bat` một lần là có.

## Cài một lần trên mỗi máy

Bấm đúp **`dang-ky-mo-file.bat`**. Không cần quyền admin — nó ghi vào phần registry
của riêng tài khoản bạn.

Lần đầu bấm nút trên web, trình duyệt hỏi *"Mở Windows PowerShell?"* → chọn **Mở**.
Tick "luôn cho phép" thì lần sau không hỏi nữa.

Lần đầu tiên nút cũng hỏi **thư mục gốc trên máy này** — mở thư mục `04.WEB` trong
Explorer, chép đường dẫn ở thanh địa chỉ rồi dán vào. Câu trả lời lưu trong trình
duyệt của bạn, không gửi lên máy chủ.

> **Đổi lại thư mục gốc:** giữ **Ctrl** khi bấm nút.

Gỡ bỏ: mở Command Prompt tại thư mục dự án, gõ `dang-ky-mo-file.bat /go`.

## Vì sao phải cài, không bấm thẳng là xong

Trình duyệt **chặn mọi liên kết `file://` mở từ trang `https://`**. Chrome và Edge
chặn im lặng — bấm không phản ứng gì, không báo lỗi, không có gì trong console. Đó
là chốt an toàn của trình duyệt, không phải lỗi sửa được bằng mã trang web.

Nên nút đi qua một giao thức riêng `bim://` do `dang-ky-mo-file.bat` đăng ký, trỏ
vào `scripts/mo-file-tren-may.ps1`.

## Đường dẫn lưu ở đâu

Bảng chỉ giữ đường dẫn **tương đối** tính từ thư mục gốc, ví dụ:

```
2 Cau Can\1 CKN\II.1-2 CKN T68-T78\1 Dang trinh PDF\ban-ve.pdf
```

Tương đối chứ không tuyệt đối vì hai lý do: mỗi máy map ổ mạng một kiểu (máy này ổ
`Z:`, máy kia gõ UNC), và đường dẫn tuyệt đối mang tên máy chủ nội bộ — thứ không
nên nằm trong cơ sở dữ liệu dùng chung. Trình duyệt ghép nó với thư mục gốc bạn khai.

## Khi bấm mà không ra gì

| Hiện tượng | Nguyên nhân | Cách xử |
|---|---|---|
| Bấm không phản ứng gì | máy chưa chạy `dang-ky-mo-file.bat` | chạy nó một lần |
| Trình duyệt hỏi rồi không mở | thư mục dự án đã bị dời đi | chạy lại `dang-ky-mo-file.bat` |
| Hộp thoại *"Không mở được"* | chưa đăng nhập ổ mạng, hoặc thư mục gốc khai sai | mở thử đường dẫn trong Explorer; giữ Ctrl bấm nút để khai lại |
| *"Không thấy file… đã mở thư mục chứa nó"* | file có trên web nhưng chưa kéo về máy | chạy đồng bộ rồi thử lại |
| Không thấy nút ở file nào cả | chưa đăng nhập, hoặc chưa đồng bộ lần nào | đăng nhập; chạy `dong-bo-ghi-that.bat` |

## Về an toàn

`scripts/mo-file-tren-may.ps1` là **điểm trang web gọi vào máy bạn**, nên nó coi
chuỗi nhận được là dữ liệu không tin được:

- chỉ gọi đúng `explorer.exe`, truyền đường dẫn qua `ArgumentList` — không
  `Invoke-Expression`, không ghép vào lệnh shell;
- từ chối đường dẫn tương đối, mọi đoạn `..`, ký tự điều khiển và `< > | ? * "`.

Kịch bản xấu nhất nếu ai đó lừa được: Explorer mở nhầm một thư mục. Không có đường
nào từ đây chạy được chương trình do trang web chỉ định.

Máy chủ cũng lọc hai đầu: `locNasPath()` chặn đường dẫn tuyệt đối do client gửi lên,
`boNasPathNeuKhongQuyen()` cắt đường dẫn khỏi dữ liệu trả cho người chỉ xem.
`node scratch/thu-nas-path.mjs` canh cả hai.
