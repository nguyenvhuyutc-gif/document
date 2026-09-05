// Kiểm scripts/dong-bo/day-len.mjs — module đẩy file NAS lên bảng (bim-03).
// Dùng thư mục tạm thật của hệ điều hành và `nenTang` giả, KHÔNG chạm mạng.
//   node scripts/thu-day-len.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { quetThuMuc, locFileChuaOnDinh, soKhop, dayCaDong } from "./dong-bo/day-len.mjs";

let dat = 0, hong = 0;
const ok = (s) => { dat++; console.log("  ✓ " + s); };
const loi = (s, ct) => { hong++; console.log("  ✗ " + s + (ct ? "\n      → " + ct : "")); };

// nền tảng giả: đủ cho module này, không cần chờ bim-02
const nenTangGia = { duongDai: (p) => p };

const goc = await fs.mkdtemp(path.join(os.tmpdir(), "thu-day-len-"));
const nghi = (ms) => new Promise((r) => setTimeout(r, ms));

// tạo file với mtime lùi về quá khứ `tuoiGiay` giây
async function taoFile(thuMuc, ten, noiDung, tuoiGiay = 0) {
  const p = path.join(thuMuc, ten);
  await fs.writeFile(p, noiDung);
  if (tuoiGiay) {
    const t = new Date(Date.now() - tuoiGiay * 1000);
    await fs.utimes(p, t, t);
  }
  return p;
}

try {
  console.log("\n══ day-len.mjs ══\n");

  // ---------------- quetThuMuc ----------------
  console.log("  ── quetThuMuc ──");
  {
    const d = path.join(goc, "PDF");
    await fs.mkdir(d, { recursive: true });
    await taoFile(d, "b-ban-ve.pdf", "xin chao", 3600);
    await taoFile(d, "a-thuyet-minh.pdf", "abc", 3600);
    await taoFile(d, "~$ban-ve.docx", "rac", 3600);       // Office đang mở
    await taoFile(d, ".bim-id", "row-1", 3600);            // dấu của cây thư mục
    await taoFile(d, "Thumbs.db", "rac", 3600);
    await taoFile(d, "desktop.ini", "rac", 3600);
    await taoFile(d, ".an", "rac", 3600);                  // file ẩn
    await taoFile(d, "ban-ve-tai-do.pdf.bim-tam", "moi tai duoc nua", 3600);   // keo-ve tải dở
    await fs.mkdir(path.join(d, "thu-muc-con"), { recursive: true });

    const ds = await quetThuMuc(d, nenTangGia);
    const ten = ds.map((f) => f.ten);
    if (JSON.stringify(ten) === JSON.stringify(["a-thuyet-minh.pdf", "b-ban-ve.pdf"]))
      ok("chỉ lấy file thật, bỏ ~$ / .bim-id / Thumbs.db / desktop.ini / file ẩn / thư mục con");
    else loi("lọc sai", ten.join(" | "));
    // Ca này hỏng nghĩa là: file keo-ve tải dở sẽ bị đẩy NGƯỢC lên web thành hồ sơ
    // chính thức — vòng tròn khép kín giữa hai module.
    if (!ten.some((t) => t.endsWith(".bim-tam"))) ok("bỏ qua file tải dở đuôi .bim-tam của keo-ve");
    else loi("file tải dở lọt vào danh sách đẩy", ten.join(" | "));

    if (ds[0].size === 3 && typeof ds[0].mtime === "number" && ds[0].duongDan.endsWith("a-thuyet-minh.pdf"))
      ok("FileDia đủ trường {ten, size, mtime, duongDan}");
    else loi("FileDia sai hình dạng", JSON.stringify(ds[0]));

    const trong = await quetThuMuc(path.join(goc, "khong-co-thu-muc-nay"), nenTangGia);
    if (Array.isArray(trong) && !trong.length) ok("thư mục chưa tồn tại → mảng rỗng, không ném lỗi");
    else loi("thư mục thiếu mà không trả mảng rỗng", JSON.stringify(trong));

    if (!(await quetThuMuc("", nenTangGia)).length) ok("đường dẫn rỗng → mảng rỗng");
    else loi("đường dẫn rỗng không trả mảng rỗng");
  }

  // ---------------- locFileChuaOnDinh — phần khó nhất ----------------
  console.log("\n  ── locFileChuaOnDinh (chốt file đang copy dở) ──");
  {
    const d = path.join(goc, "on-dinh");
    await fs.mkdir(d, { recursive: true });
    await taoFile(d, "cu-va-yen.pdf", "noi dung on dinh", 3600);   // cũ, đứng yên
    await taoFile(d, "vua-tao.pdf", "moi toanh", 0);               // vừa tạo xong
    const ds = await quetThuMuc(d, nenTangGia);

    const kq = await locFileChuaOnDinh(ds, { doiLaiMs: 150 });
    if (kq.dung.map((f) => f.ten).join() === "cu-va-yen.pdf") ok("chốt 1: file cũ và đứng yên → được đẩy");
    else loi("chốt 1 sai ở phần `dung`", kq.dung.map((f) => f.ten).join("|"));
    if (kq.cho.map((f) => f.ten).join() === "vua-tao.pdf") ok("chốt 1: file vừa tạo (mtime quá mới) → chờ lần sau");
    else loi("chốt 1 sai ở phần `cho`", kq.cho.map((f) => f.ten).join("|"));
  }
  {
    // Đây là ca quan trọng nhất của cả module: file CŨ (qua được chốt 1) nhưng đang
    // được chép dở — kích thước còn bò lên. Chốt 2 phải bắt được.
    const d = path.join(goc, "dang-chep");
    await fs.mkdir(d, { recursive: true });
    const p = await taoFile(d, "dang-chep.dwg", "phan dau", 3600);
    await taoFile(d, "yen-tinh.dwg", "khong doi", 3600);
    const ds = await quetThuMuc(d, nenTangGia);

    const dangChay = locFileChuaOnDinh(ds, { doiLaiMs: 400 });
    await nghi(120);
    await fs.appendFile(p, "phan duoi vua duoc chep them");   // giả cảnh copy chưa xong
    const kq = await dangChay;

    if (kq.cho.map((f) => f.ten).join() === "dang-chep.dwg")
      ok("chốt 2: file cũ nhưng kích thước còn đổi → CHỜ (không đẩy bản dở)");
    else loi("CHỐT 2 HỎNG — file copy dở sẽ bị đẩy lên hỏng vĩnh viễn",
      "cho=" + kq.cho.map((f) => f.ten).join("|") + " dung=" + kq.dung.map((f) => f.ten).join("|"));
    if (kq.dung.map((f) => f.ten).join() === "yen-tinh.dwg")
      ok("chốt 2: file đứng yên bên cạnh vẫn được đẩy bình thường");
    else loi("chốt 2 chặn nhầm file yên tĩnh", kq.dung.map((f) => f.ten).join("|"));
  }
  {
    const d = path.join(goc, "bien-mat");
    await fs.mkdir(d, { recursive: true });
    const p = await taoFile(d, "se-bi-xoa.pdf", "abc", 3600);
    const ds = await quetThuMuc(d, nenTangGia);
    const dangChay = locFileChuaOnDinh(ds, { doiLaiMs: 300 });
    await nghi(80);
    await fs.rm(p);
    const kq = await dangChay;
    if (!kq.dung.length && kq.cho.length === 1) ok("file bị xoá giữa hai lần đọc → chờ, không ném lỗi");
    else loi("xử lý sai khi file biến mất giữa chừng", JSON.stringify({ dung: kq.dung.length, cho: kq.cho.length }));
  }
  {
    const kq = await locFileChuaOnDinh([], { doiLaiMs: 5000 });
    if (!kq.dung.length && !kq.cho.length) ok("danh sách rỗng → về ngay, không nghỉ 3 giây vô ích");
    else loi("danh sách rỗng xử lý sai");
  }

  // ---------------- soKhop ----------------
  console.log("\n  ── soKhop ──");
  {
    const dia = [
      { ten: "a.pdf", size: 10, mtime: 1, duongDan: "x/a.pdf" },
      { ten: "b.pdf", size: 20, mtime: 1, duongDan: "x/b.pdf" },
      { ten: "c.pdf", size: 30, mtime: 1, duongDan: "x/c.pdf" },
    ];
    const bang = [
      { id: "1", name: "a.pdf", size: 10 },      // trùng cả tên lẫn cỡ
      { id: "2", name: "b.pdf", size: 999 },     // trùng tên, KHÁC cỡ → phải đẩy lại
    ];
    const kq = soKhop(dia, bang);
    if (kq.daCo.map((f) => f.ten).join() === "a.pdf") ok("trùng tên + kích thước → coi là đã có");
    else loi("nhận nhầm file đã có", kq.daCo.map((f) => f.ten).join("|"));
    if (kq.canDay.map((f) => f.ten).join() === "b.pdf,c.pdf")
      ok("khác kích thước hoặc chưa có → vào danh sách cần đẩy");
    else loi("danh sách cần đẩy sai", kq.canDay.map((f) => f.ten).join("|"));

    const rong = soKhop(dia, undefined);
    if (rong.canDay.length === 3) ok("cột chưa có file nào (undefined) → tất cả cần đẩy");
    else loi("không chịu được mảng bảng undefined");
  }

  // ---------------- dayCaDong (chạy khô, không chạm mạng) ----------------
  console.log("\n  ── dayCaDong ──");
  {
    const d1 = path.join(goc, "dong", "PDF");
    const d2 = path.join(goc, "dong", "TVGS");
    await fs.mkdir(d1, { recursive: true });
    await fs.mkdir(d2, { recursive: true });
    await taoFile(d1, "ban-ve.pdf", "noi dung", 3600);
    await taoFile(d2, "y-kien.pdf", "noi dung", 3600);
    const dsPdf = await quetThuMuc(d1, nenTangGia);
    const dsTvgs = await quetThuMuc(d2, nenTangGia);

    const nhat = [];
    // dạng 1: map { cột: [file] }
    const kq = await dayCaDong({}, { id: "r1" }, { filesTvgs: dsTvgs, files: dsPdf }, nenTangGia,
      { chayKho: true, onLog: (m) => nhat.push(m) });
    if (!kq.daDay.length && kq.seDay.length === 2) ok("chạy khô: KHÔNG đẩy gì, chỉ mô tả việc sẽ làm");
    else loi("chạy khô vẫn đẩy hoặc mô tả sai", JSON.stringify({ daDay: kq.daDay.length, seDay: kq.seDay.length }));
    if (kq.seDay.map((f) => f.cot).join() === "files,filesTvgs")
      ok("xếp theo ĐÚNG thứ tự cột của bảng, không theo thứ tự người gọi truyền vào");
    else loi("sai thứ tự cột", kq.seDay.map((f) => f.cot).join("|"));
    if (nhat.length === 2 && nhat.every((m) => m.startsWith("[chạy khô]"))) ok("có báo tiến độ qua onLog");
    else loi("onLog sai", nhat.join(" / "));

    // hợp đồng chốt: CHỈ nhận map. Mảng phẳng phải bị từ chối rõ ràng, không âm thầm
    // xử lý — hai hình dạng cùng chạy được là mời gọi lệch nhau về sau.
    let nem = null;
    try { await dayCaDong({}, { id: "r1" }, [{ ten: "x.pdf", size: 1, mtime: 1, duongDan: "x", cot: "files" }], nenTangGia, {}); }
    catch (e) { nem = e.message; }
    if (nem && /map/i.test(nem)) ok("truyền mảng thay vì map → ném lỗi chỉ thẳng vào hợp đồng");
    else loi("nhận cả mảng — hai hình dạng cùng sống là mầm lệch", String(nem));

    let nem2 = null;
    try { await dayCaDong({}, { id: "r1" }, { filesLa: [] }, nenTangGia, {}); }
    catch (e) { nem2 = e.message; }
    if (nem2 && /cột lạ/i.test(nem2)) ok("tên cột lạ → ném lỗi, không im lặng bỏ qua");
    else loi("cột lạ bị nuốt mất", String(nem2));

    // file chưa ổn định vẫn phải bị chặn ở đây, không chỉ ở chỗ điều phối
    const d3 = path.join(goc, "dong2", "PDF");
    await fs.mkdir(d3, { recursive: true });
    await taoFile(d3, "moi-tinh.pdf", "vua tao", 0);
    const ds3 = await quetThuMuc(d3, nenTangGia);
    const kq3 = await dayCaDong({}, { id: "r2" }, { files: ds3 }, nenTangGia, { chayKho: true });
    if (!kq3.seDay.length && kq3.cho.length === 1)
      ok("dayCaDong lọc lại độ ổn định: file vừa tạo không lọt vào danh sách đẩy");
    else loi("dayCaDong bỏ qua chốt ổn định", JSON.stringify({ seDay: kq3.seDay.length, cho: kq3.cho.length }));

    const batDau = Date.now();
    const kq4 = await dayCaDong({}, { id: "r3" }, {}, nenTangGia, { chayKho: true });
    const tonMs = Date.now() - batDau;
    if (!kq4.seDay.length && !kq4.cho.length && !kq4.loi.length) ok("không có gì cần đẩy → trả kết quả rỗng, không lỗi");
    else loi("dòng rỗng xử lý sai", JSON.stringify(kq4));
    // Chốt chi phí: dòng rỗng mà vẫn nghỉ 3 giây thì bảng vài chục dòng ngốn hàng
    // phút chỉ để nằm chờ, mỗi lần chạy.
    if (tonMs < 1000) ok("dòng rỗng KHÔNG nghỉ 3 giây (" + tonMs + "ms)");
    else loi("dòng rỗng vẫn nằm chờ — chi phí nhân theo số dòng", tonMs + "ms");
    if (!("boQua" in kq4)) ok("đã bỏ hẳn trường `boQua` (trường luôn rỗng chỉ gây hoang mang)");
    else loi("vẫn còn trường boQua");
  }
} finally {
  await fs.rm(goc, { recursive: true, force: true });
  console.log("\n  (đã xoá thư mục tạm)");
}

console.log("\n  ════ " + dat + " đạt, " + hong + " hỏng ════\n");
process.exit(hong ? 1 : 0);
