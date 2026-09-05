// ============================================================
//  nen-tang.mjs — cấu hình, đường dẫn dài, khoá chạy, đọc/ghi bảng, sổ ghi.
//  Hợp đồng: scripts/dong-bo/HOP-DONG.md · Chủ sở hữu: bim-02
//
//  Module CHỈ export hàm: không chạy gì lúc import, không process.exit(),
//  không console.log. Lỗi thì throw Error kèm câu tiếng Việt.
//  Chỉ dùng EDIT_KEY. Node thuần, không thêm phụ thuộc npm.
// ============================================================
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TEN_KHOA = ".bim-sync.lock";
const TEN_SO = ".bim-sync.json";

// ---------- cấu hình ----------

// Chỉ nhìn TRONG thuMucScript, không lần lên thư mục cha: máy chạy script là máy
// trạm không có repo, và lần lên cha là đường để vớ nhầm .env của dự án (chứa
// connection string MongoDB) thay vì .env của script.
export function docCauHinh(thuMucScript) {
  if (!thuMucScript) throw new Error("docCauHinh: thiếu đường dẫn thư mục script");
  const ungVien = [".env.dong-bo", ".env"].map((t) => path.join(thuMucScript, t));
  const tep = ungVien.find((p) => fs.existsSync(p));
  if (!tep) throw new Error("không tìm thấy .env.dong-bo (hoặc .env) trong " + thuMucScript);

  const env = {};
  for (const dong of fs.readFileSync(tep, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(dong);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }

  const can = ["EDIT_KEY", "BASE_URL", "THU_MUC_GOC", "PLAN_ID"];
  const thieu = can.filter((k) => !env[k]);
  if (thieu.length) throw new Error("thiếu biến trong " + tep + ": " + thieu.join(", "));
  if (!/^https?:\/\//i.test(env.BASE_URL)) throw new Error("BASE_URL phải bắt đầu bằng http:// hoặc https://");

  // Chỉ chép đúng bốn biến cần. ADMIN_KEY dù có trong file cũng không đi tiếp.
  return {
    EDIT_KEY: env.EDIT_KEY,
    BASE_URL: env.BASE_URL.replace(/\/+$/, ""),
    THU_MUC_GOC: env.THU_MUC_GOC,
    PLAN_ID: env.PLAN_ID,
  };
}

// ---------- đường dẫn dài ----------

// \\?\ tắt mọi phép chuẩn hoá của Windows nên CHỈ nhận đường dẫn tuyệt đối đã
// chuẩn hoá sẵn — còn "." , ".." hay dấu "/" là hỏng. Vì vậy phải resolve TRƯỚC.
// UNC ăn mất một cặp gạch chéo đầu: \\nas\share → \\?\UNC\nas\share.
export function duongDai(p, nen = process.platform) {
  if (typeof p !== "string" || !p) throw new Error("duongDai: đường dẫn rỗng");
  if (nen !== "win32") return path.resolve(p);
  if (p.startsWith("\\\\?\\") || p.startsWith("\\\\.\\")) return p;  // đã có tiền tố
  // resolve() để lại gạch chéo cuối ở gốc chia sẻ (\\nas\share\). Bỏ nó đi —
  // trừ gốc ổ đĩa, vì "\\?\Z:" thiếu gạch chéo là đường dẫn không hợp lệ.
  let r = path.win32.resolve(p);
  if (r.endsWith("\\") && !/^[A-Za-z]:\\$/.test(r)) r = r.replace(/\\+$/, "");
  return r.startsWith("\\\\") ? "\\\\?\\UNC\\" + r.slice(2) : "\\\\?\\" + r;
}

// ---------- khoá chạy ----------

// Khoá nằm TRÊN NAS chứ không phải trên máy — đó là chỗ duy nhất mọi máy trạm
// cùng nhìn thấy. Khoá tự hết hạn sau hanPhut vì script bị Ctrl+C sẽ không kịp
// dọn, và không ai muốn phải vào NAS xoá tay.
export async function layKhoa(thuMucGoc, { hanPhut = 30, chayKho = false } = {}) {
  const tep = duongDai(path.join(thuMucGoc, TEN_KHOA));
  const cua = { may: os.hostname(), luc: Date.now() };
  const noiDung = JSON.stringify(cua);

  const doiChu = async () => {
    let cu = null;
    try { cu = JSON.parse(await fsp.readFile(tep, "utf8")); } catch { cu = null; }
    // Khoá hỏng hoặc thiếu mốc giờ: coi như rác, chiếm lại.
    const con = cu && Number(cu.luc) && Date.now() - Number(cu.luc) < hanPhut * 60000;
    if (con) return { duocPhep: false, chuSoHuu: String(cu.may || "máy không rõ tên"), nhaKhoa: async () => {} };
    if (!chayKho) await fsp.writeFile(tep, noiDung, "utf8");   // chiếm lại
    return { duocPhep: true, chuSoHuu: cua.may, nhaKhoa: taoNhaKhoa(tep, cua, chayKho) };
  };

  if (chayKho) {
    // Chạy khô không được ghi gì lên NAS, nhưng vẫn phải nói được máy khác có
    // đang giữ khoá hay không.
    if (!fs.existsSync(tep)) return { duocPhep: true, chuSoHuu: cua.may, nhaKhoa: async () => {} };
    return doiChu();
  }
  try {
    await fsp.writeFile(tep, noiDung, { encoding: "utf8", flag: "wx" });  // tạo mới, không đè
    return { duocPhep: true, chuSoHuu: cua.may, nhaKhoa: taoNhaKhoa(tep, cua, false) };
  } catch (e) {
    if (e.code !== "EEXIST") throw new Error("không ghi được khoá trên NAS: " + e.message);
    return doiChu();
  }
}

// Chỉ xoá khoá nếu nó vẫn là khoá của mình: khoá quá hạn có thể đã bị máy khác
// chiếm trong lúc mình chạy, xoá bừa là đá văng phiên đang chạy của họ.
function taoNhaKhoa(tep, cua, chayKho) {
  return async () => {
    if (chayKho) return;
    try {
      const cu = JSON.parse(await fsp.readFile(tep, "utf8"));
      if (cu.may !== cua.may || Number(cu.luc) !== cua.luc) return;
      await fsp.unlink(tep);
    } catch { /* khoá đã mất hoặc hỏng — không có gì để dọn */ }
  };
}

// ---------- bảng trên web ----------

// Document trên máy chủ là { rows, people, statuses }. docBang chỉ trả rows theo
// hợp đồng, nhưng phải NHỚ nguyên bản: POST ghi đè cả document, gửi mỗi { rows }
// là xoá sạch people và statuses của mọi người.
const banDaDoc = new Map();
const khoaBan = (c) => c.BASE_URL + "|" + c.PLAN_ID;

async function goiApi(url, opt, viec) {
  let r;
  try { r = await fetch(url, { ...opt, signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw new Error(viec + " thất bại (không nối được máy chủ): " + e.message); }
  let j = null;
  try { j = await r.json(); } catch { /* để nhánh dưới báo theo mã HTTP */ }
  return { r, j };
}

export async function docBang(cauHinh) {
  const url = `${cauHinh.BASE_URL}/api/data?plan=${encodeURIComponent(cauHinh.PLAN_ID)}`;
  const { r, j } = await goiApi(url, { method: "GET" }, "đọc bảng");
  if (!r.ok || !j || !j.ok) throw new Error("đọc bảng thất bại: HTTP " + r.status + (j && j.error ? " — " + j.error : ""));
  const data = j.data && typeof j.data === "object" ? j.data : {};
  banDaDoc.set(khoaBan(cauHinh), data);
  return { rows: Array.isArray(data.rows) ? data.rows : [], mtime: Number(j.mtime) || 0, name: j.name || null };
}

export async function ghiBangMotDong(cauHinh, rows, mtime) {
  const goc = banDaDoc.get(khoaBan(cauHinh));
  if (!goc) throw new Error("phải gọi docBang() trước khi ghi — thiếu bản gốc thì people/statuses sẽ bị xoá");
  if (!Array.isArray(rows)) throw new Error("ghiBangMotDong: rows phải là mảng");

  const url = `${cauHinh.BASE_URL}/api/data?plan=${encodeURIComponent(cauHinh.PLAN_ID)}&ifMtime=${Number(mtime) || 0}`;
  const { r, j } = await goiApi(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-edit-key": cauHinh.EDIT_KEY },
    body: JSON.stringify({ ...goc, rows }),
  }, "ghi bảng");

  // 409 ở đây nghĩa là XUNG ĐỘT, không phải lỗi: có người vừa lưu bản khác.
  if (r.status === 409 || (j && j.conflict)) throw new Error("XUNG_DOT");
  if (r.status === 401 || r.status === 403) throw new Error("ghi bảng bị từ chối: EDIT_KEY sai hoặc thiếu quyền");
  if (!r.ok || !j || !j.ok) throw new Error("ghi bảng thất bại: HTTP " + r.status + (j && j.error ? " — " + j.error : ""));

  banDaDoc.set(khoaBan(cauHinh), { ...goc, rows });   // bản mới thành bản gốc cho lần ghi sau
  return { mtime: Number(j.mtime) || 0 };
}

// ---------- sổ ghi ----------

// Sổ ghi là thứ phân biệt "file mới trên đĩa" với "file đã bị xoá trên web".
// Sổ hỏng mà ném lỗi thì cả lần chạy đứng; sổ rỗng chỉ khiến lần chạy này thận
// trọng hơn — nên hỏng luôn quy về rỗng.
export async function docSoGhi(thuMucGoc) {
  try {
    const so = JSON.parse(await fsp.readFile(duongDai(path.join(thuMucGoc, TEN_SO)), "utf8"));
    if (!so || typeof so !== "object" || typeof so.files !== "object" || so.files === null) return soRong();
    return { planId: so.planId || "", capNhat: Number(so.capNhat) || 0, files: so.files };
  } catch { return soRong(); }
}

const soRong = () => ({ planId: "", capNhat: 0, files: {} });

export async function ghiSoGhi(thuMucGoc, so, { chayKho = false } = {}) {
  if (chayKho) return;
  const tep = duongDai(path.join(thuMucGoc, TEN_SO));
  const tam = tep + ".tam";
  const noi = JSON.stringify({ planId: so.planId || "", capNhat: Date.now(), files: so.files || {} }, null, 2);
  // Ghi tạm rồi đổi tên: mất điện giữa chừng thì sổ cũ còn nguyên, không thành file cụt.
  try {
    await fsp.writeFile(tam, noi, "utf8");
    await fsp.rename(tam, tep);
  } catch (e) {
    try { await fsp.unlink(tam); } catch { /* không có gì để dọn */ }
    throw new Error("không ghi được sổ ghi trên NAS: " + e.message);
  }
}

// Khoá định danh của một file trong sổ ghi. Ghép đúng cách này ở MỌI module —
// đổi cách ghép là mọi file cũ thành "chưa từng thấy" và bị đẩy lên lại.
//
// KHÔNG có size trong khoá, cố ý: sửa một bản vẽ rồi lưu đè (chuyện hằng ngày)
// giữ nguyên tên nhưng đổi size, mà nếu size nằm trong khoá thì sổ ghi coi bản cũ
// là "đã bị xoá khỏi thư mục" và báo động giả mỗi lần sửa file. Mục "cần bạn
// quyết" đầy báo giả thì người dùng ngừng đọc, và cảnh báo THẬT chìm theo.
// size vẫn được lưu trong sổ (ngoài khoá) để phát hiện file đổi nội dung.
export function khoaFile(rowId, cot, ten) {
  return `${rowId}|${cot}|${ten}`;
}
