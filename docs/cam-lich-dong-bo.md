# Cắm lịch chạy đồng bộ NAS (Task Scheduler)

Chạy tay thì bấm đúp `dong-bo.bat`. Tài liệu này nói về việc để Windows **tự chạy
15 phút một lần**.

> **CHỈ MỘT MÁY ĐƯỢC CẮM LỊCH.** Đọc § Vì sao chỉ một máy trước khi làm.

---

## Trước khi cắm

1. Máy đã cài **Node.js 20 trở lên** (`node -v` trong Command Prompt).
2. Đã có `scripts\.env.dong-bo` điền đủ bốn biến (chép từ `.env.dong-bo.example`).
3. **Đã chạy tay ít nhất một lần và đọc hết kết quả:**

   ```
   dong-bo.bat                 (chạy khô — chỉ in ra việc sẽ làm)
   dong-bo.bat --thuc-hien     (ghi thật)
   ```

   Chưa chạy tay thành công thì đừng cắm lịch. Lỗi cấu hình lúc chạy tay hiện
   ngay trên màn hình; lỗi cấu hình lúc chạy theo lịch chỉ nằm im trong file log.

4. `THU_MUC_GOC` phải là **UNC**, không phải ổ map:

   ```
   ✔ THU_MUC_GOC=\\<ten-nas>\projects\<share>\2026\<thu-muc-du-an>
   ✘ THU_MUC_GOC=Z:\<thu-muc-du-an>
   ```

   Ổ map chỉ tồn tại trong phiên đăng nhập của người đã map nó. Task Scheduler
   chạy dưới một phiên khác và sẽ **không thấy ổ Z:** — tác vụ báo lỗi "không tìm
   thấy thư mục" dù mở Explorer vẫn thấy bình thường. Đây là lỗi tốn thời gian
   nhất trong cả quy trình này.

---

## Cắm bằng dòng lệnh (nhanh)

Mở **Command Prompt với quyền quản trị**, thay đường dẫn cho đúng máy:

```cmd
schtasks /create /tn "Dong bo NAS - bang hang muc" ^
  /tr "\"D:\duong-dan-toi\bim\dong-bo-theo-lich.bat\"" ^
  /sc minute /mo 15 ^
  /ru "%USERDOMAIN%\%USERNAME%" /rp * ^
  /rl LIMITED /f
```

- `/mo 15` — 15 phút một lần
- `/ru … /rp *` — chạy dưới tài khoản của bạn, Windows sẽ **hỏi mật khẩu**. Bắt
  buộc, vì tác vụ cần quyền vào NAS.
- `/rl LIMITED` — **không** chạy quyền cao nhất. Script chỉ đọc/ghi thư mục dự án,
  không cần quyền quản trị, và không nên có.

Xoá lịch: `schtasks /delete /tn "Dong bo NAS - bang hang muc" /f`

---

## Cắm bằng giao diện

Mở **Task Scheduler** → *Create Task* (không phải *Create Basic Task*).

| Thẻ | Đặt gì |
|---|---|
| General | Tên: `Dong bo NAS - bang hang muc`. Chọn **Run whether user is logged on or not**. **Không** tick *Run with highest privileges*. |
| Triggers | *New* → *Daily*, lặp lúc 00:00 → tick **Repeat task every 15 minutes** → *for a duration of* **Indefinitely** |
| Actions | *Start a program* → Program: `dong-bo-theo-lich.bat` (đường dẫn đầy đủ). **Start in:** thư mục chứa file đó — bỏ trống là tác vụ chạy ở `C:\Windows\System32` và không tìm thấy `scripts\` |
| Conditions | **Bỏ tick** *Start the task only if the computer is on AC power* (nếu là laptop). Bỏ tick *Stop if the computer switches to battery power* |
| Settings | Tick *Stop the task if it runs longer than* → **2 hours**. Chọn *Do not start a new instance* ở ô cuối |

**"Do not start a new instance"** là quan trọng: lần đầu kéo 624 MB có thể lâu hơn
15 phút, và không có mục này thì Windows chồng tác vụ lên nhau.

---

## Quy mô thật (đo trên NAS ngày 05/09/2026)

| | |
|---|---|
| Thư mục gốc | `\\<ten-nas>\projects\<share>\2026\<thu-muc-du-an>` (69 ký tự) |
| Cây dựng ra | **195 thư mục** — 45 thư mục dòng + thư mục cột của các dòng có file |
| File phải kéo về lần đầu | ~30 file, khoảng 624 MB |

Lần chạy đầu là lần lâu nhất. Từ lần thứ hai trở đi chỉ đụng phần thay đổi, thường
xong trong vài chục giây.

Thư mục cũ của công ty (`01.MANEGER`, `02.INPUT`, `03.OUTPUT`, `260728`…) **không bị
đụng tới** — script chỉ đọc và sửa thư mục có dấu `.bim-id` do chính nó tạo.

---

## Về giới hạn 260 ký tự — đã đo, không còn là chuyện của việc ghi

Đo thật trên chính NAS này: ghi và đọc lại được file ở đường dẫn **1039 ký tự** (dùng
tiền tố `\\?\UNC\`), gãy ở 1072. Không có tiền tố thì được 1012.

Nghĩa là **script luôn ghi được**, kể cả cây thư mục sâu nhất. Giới hạn 260 ký tự
còn lại chỉ áp cho **Explorer, AutoCAD và Excel trên máy chưa bật LongPathsEnabled** —
tức người mở file bằng tay, không phải script.

Kiểm một máy đã bật chưa (Command Prompt):

```cmd
reg query HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled
```

`0x1` là đã bật. `0x0` hoặc báo không tìm thấy là chưa — máy đó sẽ không mở nổi các
thư mục sâu, dù đồng bộ vẫn chạy đúng. Script có in cảnh báo cho từng thư mục vượt
ngưỡng, đọc trong log.

**Đừng vì thấy máy mình mở được mà kết luận mọi máy đều mở được:** máy đã bật
LongPaths cư xử khác hẳn máy chưa bật, và mặc định của Windows là **chưa bật**.

---

## Vì sao chỉ một máy

Script có khoá `.bim-sync.lock` đặt trên NAS, nên hai máy chạy cùng lúc thì máy
thứ hai nhường và thoát êm — **không hỏng dữ liệu**. Nhưng khoá là lưới an toàn,
không phải giấy phép:

- Hai máy cắm lịch 15 phút thì gần như lúc nào cũng có một máy bị chặn. Nhìn log
  sẽ thấy toàn dòng "máy khác đang chạy" và không ai biết việc có thực sự chạy không.
- Khoá tự hết hạn sau 30 phút. Máy nào treo giữa chừng thì trong 30 phút đó máy
  còn lại cũng đứng theo.
- Sửa cấu hình sai ở một máy (sai `PLAN_ID` chẳng hạn) sẽ đẩy file vào nhầm kế
  hoạch, và có hai máy thì lâu phát hiện hơn.

**Chọn một máy luôn bật.** Máy đó tắt thì không đồng bộ — chấp nhận được, vì chạy
tay lúc nào cũng được.

---

## Kiểm tra sau khi cắm

1. Trong Task Scheduler, chọn tác vụ → **Run** → xem cột *Last Run Result*:
   - `0x0` — chạy xong bình thường
   - `0x1` — script dừng có lý do (thiếu cấu hình, máy khác đang giữ khoá, không
     vào được NAS). **Mở log đọc**, đừng đoán.
2. Mở `nhat-ky\dong-bo-<ngày>.log` — mỗi lần chạy một khối, có giờ và mã thoát.
3. Sau ~20 phút, kiểm lại log xem đã có khối thứ hai chưa. Chưa có nghĩa là
   trigger sai.

---

## Về file log

`dong-bo-theo-lich.bat` ghi vào `nhat-ky\dong-bo-YYYY-MM-DD.log`, mỗi ngày một
file, tự xoá file cũ hơn 60 ngày.

Log **không chứa mật khẩu và không chứa URL đã ký** — script cố ý không in chúng.
Nhưng log có **tên file và tên hạng mục**, nên vẫn là dữ liệu dự án: đừng gửi ra
ngoài mà chưa xem.

Thư mục `nhat-ky/` đã có trong `.gitignore` — đừng gỡ dòng đó.

---

## Hai file .bat khác nhau ở chỗ nào

| | `dong-bo.bat` | `dong-bo-theo-lich.bat` |
|---|---|---|
| Dùng cho | người bấm đúp | Task Scheduler |
| Mặc định | **chạy khô** | **ghi thật** (`--thuc-hien` gắn sẵn) |
| Kết thúc | `pause`, giữ cửa sổ | thoát ngay |
| Kết quả | in ra màn hình | ghi vào `nhat-ky\` |

Đừng cắm `dong-bo.bat` vào Task Scheduler: nó có `pause` nên tác vụ sẽ **treo mãi
mãi** chờ một phím không ai bấm, và "Do not start a new instance" khiến mọi lần
chạy sau bị bỏ qua — nhìn bên ngoài thì tác vụ vẫn "đang chạy", thực chất đã chết.

---

## Khi có sự cố

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| `Last Run Result` = `0x1`, log nói "không tìm thấy thư mục" | `THU_MUC_GOC` là ổ map, hoặc tài khoản chạy tác vụ không có quyền vào NAS |
| Log nói "không tìm thấy Node.js trong PATH" | Node cài theo kiểu chỉ-cho-người-dùng-này, mà tác vụ chạy dưới tài khoản khác. Cài lại Node cho toàn máy |
| Log toàn dòng "máy khác đang chạy" | Có máy thứ hai cũng cắm lịch — gỡ bớt. Hoặc một lần chạy trước bị Ctrl+C, chờ tối đa 30 phút cho khoá hết hạn |
| Tác vụ "đang chạy" mãi không xong | Cắm nhầm `dong-bo.bat` (có `pause`). Đổi sang `dong-bo-theo-lich.bat` |
| Không có file log nào | Sai ô *Start in*, tác vụ đang chạy ở `C:\Windows\System32` |
| Log báo đồng bộ xong nhưng Explorer không mở được thư mục sâu | Máy đó chưa bật LongPathsEnabled — xem § Về giới hạn 260 ký tự. Đồng bộ vẫn đúng, chỉ người mở tay bị chặn |
| Log có dòng "cần bạn quyết" về file trùng tên | Hai bản vẽ khác nhau đang dùng chung một tên trên web; thư mục chỉ giữ được một. Đổi tên hoặc bỏ bớt trên web, script cố ý không tự quyết |
