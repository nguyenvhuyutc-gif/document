// Kiểm dayMotFile() THẬT: ký → PUT lên S3 → xác nhận, rồi tải lại xem tên file có
// còn nguyên dấu tiếng Việt không (bẫy Content-Disposition RFC 5987).
//
// Tách khỏi scripts/thu-day-len.mjs để bài kiểm chính chạy được offline.
//   node scripts/thu-day-len-mang.mjs
//
// GHI vào môi trường thật: tải một file vài chục byte lên S3 production rồi XOÁ HẲN
// ở khối finally. Không đụng tới kế hoạch hay bảng nào — dayMotFile không ghi bảng.
//
// ADMIN_KEY ở đây CHỈ để dọn (xoá hẳn cần quyền quản trị). Bản thân module
// day-len.mjs chỉ dùng EDIT_KEY, đúng hợp đồng.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dayMotFile, quetThuMuc } from "./dong-bo/day-len.mjs";

let dat = 0, hong = 0;
const ok = (s) => { dat++; console.log("  ✓ " + s); };
const loi = (s, ct) => { hong++; console.log("  ✗ " + s + (ct ? "\n      → " + ct : "")); };

const env = {};
for (const d of (await fs.readFile(".env", "utf8")).split(/\r?\n/)) {
  const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(d);
  if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}
const cauHinh = { EDIT_KEY: env.EDIT_KEY, BASE_URL: process.env.BASE || "https://bvtc.vcijsc.com" };

const goc = await fs.mkdtemp(path.join(os.tmpdir(), "thu-day-mang-"));
const TEN = "Bản vẽ thử — cọc khoan nhồi (T46).pdf";   // có dấu, có gạch dài, có ngoặc
let idDaTao = null;

try {
  console.log("\n══ dayMotFile — chạm mạng thật ══\n");
  await fs.writeFile(path.join(goc, TEN), "noi dung thu nghiem cua bim-03\n");
  const ds = await quetThuMuc(goc, { duongDai: (p) => p });
  const file = ds[0];

  const kq = await dayMotFile(cauHinh, file, { name: file.ten, type: "application/pdf", cot: "filesTvgs" });
  idDaTao = kq && kq.id;

  if (kq && kq.id && kq.url === "api/files?id=" + kq.id) ok("đẩy xong, trả về FileBang có id và url đúng dạng");
  else loi("FileBang sai hình dạng", JSON.stringify(kq));
  if (kq && kq.name === TEN && kq.size === file.size) ok("tên và kích thước giữ nguyên qua cả ba bước");
  else loi("tên hoặc kích thước lệch", JSON.stringify({ name: kq && kq.name, size: kq && kq.size }));
  if (kq && kq.uploadedAt && !("pairUid" in kq)) ok("có uploadedAt, KHÔNG đặt sẵn pairUid (để bảng tự ghép theo dòng)");
  else loi("thiếu uploadedAt hoặc đã khoá pairUid", JSON.stringify(kq));

  // ---- bẫy chính: tải lại xem tên file có sống sót không ----
  const r1 = await fetch(cauHinh.BASE_URL + "/api/files?id=" + kq.id, { redirect: "manual" });
  const diS3 = r1.headers.get("location");
  if (r1.status === 302 && diS3) ok("tải xuống: máy chủ chuyển hướng sang kho lưu trữ");
  else loi("không nhận được chuyển hướng", "HTTP " + r1.status);

  if (diS3) {
    const r2 = await fetch(diS3);
    const cd = r2.headers.get("content-disposition") || "";
    const ct = r2.headers.get("content-type") || "";
    if (r2.ok) ok("lấy được file từ kho lưu trữ (HTTP " + r2.status + ")");
    else loi("kho lưu trữ từ chối", "HTTP " + r2.status);
    if (/filename\*=UTF-8''/.test(cd) && decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(cd) || [])[1] || "") === TEN)
      ok("tên file có dấu tiếng Việt sống nguyên vẹn (RFC 5987) — không thành tên hex");
    else loi("BẪY CONTENT-DISPOSITION: tên file không về được nguyên dạng", cd || "(không có header)");
    if (/application\/pdf/.test(ct)) ok("Content-Type giữ đúng application/pdf");
    else loi("Content-Type lệch", ct);
    const noiDung = await r2.text();
    if (noiDung.includes("bim-03")) ok("nội dung tải về khớp nội dung đã đẩy");
    else loi("nội dung lệch", noiDung.slice(0, 60));
  }

  // ---- quá 500MB thì chặn ngay, không đụng mạng ----
  const to = { ten: "to.dwg", size: 600 * 1024 * 1024, mtime: 1, duongDan: path.join(goc, TEN) };
  let nem = null;
  try { await dayMotFile(cauHinh, to, { name: to.ten, type: "application/acad" }); }
  catch (e) { nem = e.message; }
  if (nem === "QUA_LON") ok("file vượt 500MB → throw QUA_LON đúng như hợp đồng");
  else loi("không chặn file quá lớn", String(nem));
} finally {
  if (idDaTao) {
    const r = await fetch(cauHinh.BASE_URL + "/api/files?id=" + idDaTao,
      { method: "DELETE", headers: { "x-edit-key": env.ADMIN_KEY } });
    console.log("\n  (dọn) xoá hẳn file thử " + idDaTao + ": HTTP " + r.status);
  }
  await fs.rm(goc, { recursive: true, force: true });
}

console.log("\n  ════ " + dat + " đạt, " + hong + " hỏng ════\n");
process.exit(hong ? 1 : 0);
