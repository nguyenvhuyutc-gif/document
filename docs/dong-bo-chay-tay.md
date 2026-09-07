# Chạy tay đồng bộ thư mục NAS

Dành cho người vận hành. Muốn chạy tự động theo lịch thì xem
[cam-lich-dong-bo.md](cam-lich-dong-bo.md) — nhưng **đừng làm cả hai**, chọn một.

## Hai file, khác nhau ở một chữ

| File | Bấm đúp thì | |
|---|---|---|
| `dong-bo.bat` | **chỉ in ra** việc sẽ làm | không đụng NAS lẫn web, chạy bao nhiêu lần cũng được |
| `dong-bo-ghi-that.bat` | **ghi thật**, có hỏi xác nhận | tạo thư mục, đổi tên, đẩy file lên, kéo file về |

Thói quen nên giữ: **xem trước → đọc → mới ghi thật.** Xem trước mất vài chục giây
và cho biết chính xác việc gì sắp xảy ra.

Muốn ghi thật bằng dòng lệnh thay vì bấm đúp: `dong-bo.bat --thuc-hien`.

## Quy trình

1. **Đóng Explorer và AutoCAD đang mở thư mục dự án.** Windows khoá thư mục đang mở;
   script cần đổi tên đúng thư mục đó thì hỏng, báo *"có thể đang mở"*.
2. **Bấm đúp `dong-bo.bat`.** Cửa sổ dừng ở `Press any key` để đọc — đừng đóng vội.
3. **Đọc bốn con số ở khối `SẼ LÀM`.** Đó là toàn bộ việc sắp xảy ra.
4. **Bốn số đều 0 → xong**, NAS và web đã khớp.
5. **Có số khác 0 và thấy hợp lý → bấm đúp `dong-bo-ghi-that.bat`**, gõ `y` rồi Enter.
   Khối kết quả đổi tiêu đề thành `ĐÃ LÀM` — đó là cách phân biệt hai chế độ.
6. **Chạy lại `dong-bo.bat` để kiểm.** Bốn số phải về 0 hết.

## Bốn con số

| Dòng | Nghĩa | Khi nào thấy |
|---|---|---|
| thư mục tạo mới | dựng chỗ cho hạng mục chưa có trên NAS | vừa thêm hạng mục trên web |
| thư mục đổi tên | đổi nhãn cho khớp tên trên web — **file bên trong đi theo** | vừa sửa tên hạng mục trên web |
| file đẩy lên | bản vẽ trong thư mục sẽ được tải lên web | vừa chép bản vẽ vào NAS |
| file kéo về | file trên web sẽ được tải về NAS | đồng nghiệp vừa tải file lên web |

## Ba mục ở cuối, đọc theo thứ tự

**1. CẦN BẠN QUYẾT** — quan trọng nhất. Script **không tự xử**, và sẽ báo lại y nguyên
ở mọi lần chạy sau cho tới khi bạn xử lý. Thường là hai file trùng tên trong cùng một
ô trên web: thư mục chỉ giữ được một bản nên bản kia không tải về được. Vào web đổi
tên hoặc bỏ bớt một bản.

**2. Lỗi** — việc đã thử nhưng không làm được. Câu mô tả nói rõ file nào, lý do gì.

**3. Cảnh báo** — đã làm xong nhưng có chỗ đáng biết. Ví dụ hai hạng mục rút gọn ra
cùng một tên nên một cái mang hậu tố `(2)`.

## Khi có sự cố

| Hiện tượng | Nguyên nhân | Cách xử |
|---|---|---|
| `Chua cai Node.js` | máy chưa có Node | tải bản LTS ở nodejs.org |
| `Chua co file cau hinh` | thiếu `scripts\.env.dong-bo` | chép từ file `.example` rồi điền |
| không thấy thư mục gốc | mất mạng tới NAS, hoặc đường dẫn sai | mở thử đường dẫn đó trong Explorer |
| `có thể đang mở` | Explorer/CAD đang giữ thư mục | đóng hết cửa sổ trỏ vào thư mục dự án |
| đang có máy khác chạy | khoá `.bim-sync.lock` | chờ máy đó xong; chắc chắn không ai chạy thì xoá file khoá |
| cửa sổ đóng ngay | bấm nhầm file | cả hai `.bat` đúng đều dừng ở `Press any key` |

## Hai điều đừng làm

- **Đừng chạy hai máy cùng lúc.** File khoá là lưới an toàn, không phải giấy phép.
- **Đừng sửa tên thư mục bằng tay trên NAS.** Tên thư mục là thứ script tự đồng bộ
  theo web — sửa tay thì lần chạy sau nó đổi lại.

Ngược lại, **chép bản vẽ vào thư mục thì cứ tự nhiên** — đó chính là cách đưa file lên web.

## Không bao giờ xoá

Script không xoá file ở bất kỳ bên nào, trong bất kỳ trường hợp nào. Cái gì không tự
quyết được thì để nguyên và báo ra mục *CẦN BẠN QUYẾT*. Chạy nhầm không mất dữ liệu.

Nó cũng chỉ đụng cây thư mục do chính nó tạo (`04.WEB`, nhận diện bằng dấu `.bim-id`
ẩn bên trong). Thư mục cũ của công ty nằm ngoài không bị chạm tới.
