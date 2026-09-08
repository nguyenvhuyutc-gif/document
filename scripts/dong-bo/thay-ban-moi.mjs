// ============================================================
//  thay-ban-moi.mjs — thay bản trên web bằng bản trong thư mục, khi hai bên
//  cùng tên nhưng khác nội dung. Chủ sở hữu: bim-e5
//
//  Đây là chỗ DUY NHẤT trong bộ đồng bộ có thể đụng tới bản đang nằm trên web,
//  và cũng là chỗ duy nhất đọc ADMIN_KEY. Mọi thứ khác vẫn giữ nguyên tắc cũ:
//  không xoá, không đè, gặp chuyện lạ thì báo ra rồi để nguyên.
//
//  Ba chốt giữ cho phạm vi ấy không loang:
//   1. Chỉ xử mục mang dấu `loai: "lech"` do keo-ve.mjs đóng. Mục canQuyet khác
//      vẫn chỉ được báo, không bao giờ tự xử.
//   2. Phải có người ngồi trước máy trả lời từng file. Không có bàn phím (chạy
//      theo lịch) thì không hỏi và không làm gì.
//   3. Chỉ gọi ?action=trash — giữ 30 ngày, khôi phục được, object trên S3 không
//      bị đụng. TUYỆT ĐỐI không xoá vĩnh viễn.
//
//  Module CHỈ export hàm: không chạy gì lúc import, không process.exit().
// ============================================================
import readline from "node:readline";

export function locMucLech(canQuyet) {
  return (canQuyet || []).filter((m) => m && m.loai === "lech" && m.banWeb && m.banWeb.id);
}

// Hỏi được hay không. Thiếu bàn phím (Task Scheduler) hoặc thiếu ADMIN_KEY thì
// không hỏi — im lặng bỏ qua là đúng: mục vẫn nằm ở "CẦN BẠN QUYẾT" như trước.
export function hoiDuocKhong(cauHinh) {
  if (!cauHinh || !cauHinh.ADMIN_KEY) return { duoc: false, vi: "thiếu ADMIN_KEY trong .env.dong-bo" };
  if (!process.stdin.isTTY) return { duoc: false, vi: "không có bàn phím (chạy theo lịch)" };
  return { duoc: true, vi: "" };
}

// Đọc một câu trả lời. Mặc định là KHÔNG: Enter suông, Ctrl+C, hay ký tự lạ đều
// ra "không thay". Người vội bấm Enter cho xong thì không mất gì.
export function hoiMotCau(cauHoi) {
  return new Promise((giaiQuyet) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let xong = false;
    const tra = (v) => { if (!xong) { xong = true; rl.close(); giaiQuyet(v); } };
    rl.on("close", () => tra(false));
    rl.question(cauHoi, (a) => tra(/^\s*(y|c|co|có)\s*$/i.test(String(a || ""))));
  });
}

const chuNhat = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();

// Hồ sơ gửi cho ?action=trash. Thiếu một trường là khôi phục xong file nằm rời
// khỏi dòng — `pairUid` đặc biệt dễ quên vì nó thường là chuỗi rỗng.
function hoSoRac(cauHinh, banWeb, muc, tenDong, viTri) {
  return {
    id: banWeb.id,
    planId: cauHinh.PLAN_ID,
    rowId: muc.rowId || "",
    fkey: muc.cot || "files",
    rowName: tenDong,
    uploadedAt: banWeb.uploadedAt || "",
    note: banWeb.note || "",
    viTri,
    pairUid: banWeb.pairUid || "",
  };
}

async function goiRac(cauHinh, hoSo) {
  const r = await fetch(cauHinh.BASE_URL + "/api/files?action=trash", {
    method: "POST",
    headers: { "content-type": "application/json", "x-edit-key": cauHinh.ADMIN_KEY },
    body: JSON.stringify({ items: [hoSo] }),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) {}
  if (r.status === 401 || r.status === 403) throw new Error("ADMIN_KEY sai hoặc không đủ quyền");
  if (!r.ok || !j || !j.ok) throw new Error("máy chủ từ chối (HTTP " + r.status + ")");
  return j;
}

/**
 * Thay MỘT bản. Thứ tự ba bước dưới đây không đảo được:
 *
 *   1. đẩy bản mới lên kho   — hỏng ở đây thì chưa có gì thay đổi
 *   2. ghi bảng              — hỏng ở đây thì bản mới thành file mồ côi trên S3,
 *                              script don-file-mo-coi.mjs sẽ tìm ra
 *   3. bỏ bản cũ vào rác     — hỏng ở đây thì bản cũ mồ côi, cũng tìm ra được
 *
 * Đảo 2 và 3 (rác trước, ghi bảng sau) thì có một khoảnh khắc bảng trỏ vào file
 * đã trashed: người dùng thấy file trên bảng mà bấm vào không tải được. Giao diện
 * web cũng theo đúng thứ tự này.
 *
 * Trả { ok, mtime, loi } — `mtime` là mốc mới sau khi ghi bảng, phải truyền lại
 * cho lần thay kế tiếp, nếu không lần sau ăn 409 xung đột.
 */
export async function thayMotBan(cauHinh, muc, ctx) {
  const { rows, mtime, nenTang, dayLen } = ctx;
  const banWeb = muc.banWeb;

  const row = (rows || []).find((r) => r && String(r.id) === String(muc.rowId));
  if (!row) return { ok: false, mtime, loi: "không tìm thấy dòng " + muc.rowId + " trên bảng" };
  const mang = row[muc.cot];
  if (!Array.isArray(mang)) return { ok: false, mtime, loi: "dòng không có cột " + muc.cot };

  const viTri = mang.findIndex((f) => f && String(f.id || f.uid || "") === String(banWeb.id));
  if (viTri < 0) return { ok: false, mtime, loi: "bản cũ không còn trên bảng — có người vừa sửa" };

  // 1. đẩy bản mới lên
  let moi;
  try {
    moi = await dayLen.dayMotFile(
      cauHinh,
      { duongDan: muc.duongDan, size: muc.size, ten: muc.ten },
      { name: muc.ten, type: dayLen.kieuTheoDuoi(muc.ten), cot: muc.cot }
    );
  } catch (e) {
    return { ok: false, mtime, loi: "đẩy lên thất bại: " + (e && e.message) };
  }

  // 2. ghi bảng — giữ nguyên vị trí, ghi chú và cặp ghép của bản cũ. Ghi chú đi
  // theo Ô chứ không theo file: mất nó là mất nhận xét người ta đã viết.
  const truoc = mang[viTri];
  mang[viTri] = { ...moi, note: truoc.note || "", pairUid: truoc.pairUid || "" };
  let mtimeMoi = mtime;
  try {
    const kq = await nenTang.ghiBangMotDong(cauHinh, rows, mtime);
    mtimeMoi = kq.mtime || mtime;
  } catch (e) {
    mang[viTri] = truoc;                                    // trả bảng về như cũ trong bộ nhớ
    const vi = (e && e.message) === "XUNG_DOT"
      ? "có người vừa lưu bảng — chạy lại là xong"
      : (e && e.message);
    return { ok: false, mtime, loi: "ghi bảng thất bại: " + vi
      + ". Bản mới đã lên kho nhưng chưa vào bảng — chạy scripts/don-file-mo-coi.mjs để dọn." };
  }

  // 3. bỏ bản cũ vào thùng rác
  try {
    await goiRac(cauHinh, hoSoRac(cauHinh, banWeb, muc, chuNhat(row.hangMuc), viTri));
  } catch (e) {
    return { ok: true, mtime: mtimeMoi, canhBao:
      "đã thay xong nhưng bản cũ không vào được thùng rác (" + (e && e.message)
      + ") — nó thành file mồ côi, dọn bằng scripts/don-file-mo-coi.mjs" };
  }

  return { ok: true, mtime: mtimeMoi };
}
