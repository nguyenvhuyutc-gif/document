// ============================================================
//  keo-ve.mjs — bảng quyết định ba chiều + kéo file từ web về thư mục.
//  Hợp đồng: scripts/dong-bo/HOP-DONG.md · Chủ sở hữu: bim-02
//
//  quyetDinh() là NGƯỜI QUYẾT DUY NHẤT của cả script vì chỉ nó đọc sổ ghi.
//  Không có nó thì file người dùng xoá trên web sẽ sống lại từ thư mục ở mỗi
//  lần chạy, và xoá bao nhiêu lần cũng vô ích.
// ============================================================
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

// So tên file KHÔNG phân biệt hoa thường: Windows coi "BV-01.pdf" và "bv-01.pdf"
// là một file, nên so phân biệt hoa thường sẽ ra "hai file" ở chỗ đĩa chỉ có một.
const chuan = (s) => String(s || "").trim().toLowerCase();

/**
 * Bảng quyết định ba chiều: sổ ghi (lần trước) × thư mục (bây giờ) × bảng (bây giờ).
 * HÀM THUẦN — không đụng đĩa, không gọi mạng.
 *
 * Trả thêm `boKhoiSo` ngoài hợp đồng (dòng 6 của bảng: lần trước có, hai bên đều
 * không còn → xoá khỏi sổ). Không có nó thì sổ phình mãi và mọi file từng tồn tại
 * đều bị báo động lại.
 */
export function quyetDinh(soGhi, dsDia, mangBang, rowId, cot) {
  const kq = { keoVe: [], dayLen: [], canQuyet: [], boKhoiSo: [] };
  const files = (soGhi && soGhi.files) || {};

  const dia = new Map(), bang = new Map(), truoc = new Map();

  const them = (ten, tinhHuong, phu = {}) =>
    kq.canQuyet.push({ ten, tinhHuong, rowId, cot, size: 0, ...phu });

  // Bảng CHO PHÉP hai file trùng tên trong một ô, thư mục thì không. Gộp chúng vào
  // một khoá rồi im lặng là để file thứ hai biến mất khỏi mọi con số — không kéo
  // về, không báo, không ai biết. Giữ bản ĐẦU (đúng thứ tự hiện trên bảng) để
  // quyết định, các bản sau đẩy sang canQuyet.
  for (const f of dsDia || []) {
    if (!f || !f.ten) continue;                       // trên đĩa không thể có file không tên
    const k = chuan(f.ten);
    if (dia.has(k)) them(f.ten, "trong thư mục có hai file trùng tên — chỉ bản đầu được xét",
      { size: f.size || 0, duongDan: f.duongDan });
    else dia.set(k, f);
  }
  for (const f of mangBang || []) {
    if (!f || !f.name) {
      them("(không tên)", "mục trong bảng thiếu tên file — không tải về được, cần sửa trên web",
        { size: (f && f.size) || 0, id: f && f.id });
      continue;
    }
    const k = chuan(f.name);
    if (bang.has(k)) them(f.name, "ô này có hai file trùng tên trên web — thư mục chỉ giữ được một bản, "
      + "bản này không tải về được. Đổi tên hoặc bỏ bớt trên web.", { size: f.size || 0, id: f.id });
    else bang.set(k, f);
  }
  for (const [khoa, m] of Object.entries(files)) {
    if (!m || m.rowId !== rowId || m.cot !== cot) continue;
    truoc.set(chuan(m.ten), { khoa, ...m });
  }

  for (const ten of new Set([...dia.keys(), ...bang.keys(), ...truoc.keys()])) {
    const d = dia.get(ten), b = bang.get(ten), t = truoc.get(ten);

    if (!t && d && !b) { kq.dayLen.push(d); continue; }          // file mới trong thư mục
    if (!t && !d && b) { kq.keoVe.push(b); continue; }           // chưa từng tải về
    if (t && !d && !b) { kq.boKhoiSo.push(t.khoa); continue; }   // hai bên đều hết → dọn sổ

    // Hai dòng dưới là lý do cả module này tồn tại: KHÔNG kéo lại, KHÔNG đẩy lại.
    if (t && !d && b) {
      them(b.name, "đã xoá khỏi thư mục, còn trên web — không tự tải lại", { size: b.size || 0, id: b.id });
      continue;
    }
    if (t && d && !b) {
      them(d.ten, "đã xoá trên web, còn trong thư mục — không tự đẩy lên lại",
        { size: d.size || 0, duongDan: d.duongDan });
      continue;
    }

    // Còn lại: hai bên cùng có. Không làm gì — trừ khi nội dung đã lệch nhau.
    // size lưu trong sổ (ngoài khoá) chính là để bắt được chuyện này.
    if (d && b && Number(d.size) !== Number(b.size)) {
      them(d.ten, `trong thư mục ${d.size} byte, trên web ${b.size} byte — hai bản đã khác nhau`,
        { size: d.size || 0, duongDan: d.duongDan, id: b.id });
    }
  }
  return kq;
}

// Tên file do máy chủ trả về, không phải thứ mình tự sinh — phải cắt về đúng một
// thành phần. Tên chứa "..\" hay "\" mà ghép thẳng là ghi ra ngoài thư mục cột.
function tenAnToan(ten) {
  const t = path.basename(String(ten || "").replace(/[\\/]/g, "_")).trim();
  if (!t || t === "." || t === "..") throw new Error("tên file không hợp lệ: " + JSON.stringify(ten));
  return t;
}

/**
 * Tải một file từ web về thư mục cột.
 * Trả { ok, duongDan, canQuyet, chayKho } — canQuyet là mục cần người quyết, hoặc null.
 * KHÔNG BAO GIỜ ghi đè file đã có trên đĩa.
 */
export async function keoMotFile(cauHinh, fileBang, duongDanCot, nenTang, { chayKho = false } = {}) {
  const ten = tenAnToan(fileBang && fileBang.name);
  const dich = path.join(duongDanCot, ten);
  const boc = nenTang.duongDai;
  const canQuyet = (tinhHuong, phu = {}) => ({
    ok: false, duongDan: dich,
    canQuyet: { ten, tinhHuong, rowId: fileBang.rowId || "", cot: fileBang.cot || "",
                size: fileBang.size || 0, duongDan: dich, id: fileBang.id, ...phu },
  });

  // Có sẵn trên đĩa: tuyệt đối không đè. Trùng tên mà khác kích thước là chuyện
  // người dùng phải biết, không phải chuyện script tự quyết.
  const daCo = await fsp.stat(boc(dich)).catch(() => null);
  if (daCo) {
    if (Number(daCo.size) === Number(fileBang.size)) return { ok: false, duongDan: dich, canQuyet: null, daCo: true };
    return canQuyet(`đã có file cùng tên trong thư mục (${daCo.size} byte) khác với bản trên web (${fileBang.size} byte)`);
  }

  if (chayKho) return { ok: false, duongDan: dich, canQuyet: null, chayKho: true };

  const url = `${cauHinh.BASE_URL}/api/files?id=${encodeURIComponent(fileBang.id)}`;
  let r;
  try { r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600000) }); }
  catch (e) { return canQuyet("không tải được: " + e.message); }

  // 404 ở đây KHÔNG phân biệt được "đang trong thùng rác" với "đã xoá vĩnh viễn"
  // — api/files.js cố ý trả 404 cho cả hai. Báo trung thực, đừng đoán, và đừng
  // xin ADMIN_KEY cho script chỉ để phân biệt.
  if (r.status === 404) return canQuyet("không tải được (đã vào thùng rác hoặc đã bị xoá hẳn)");
  if (!r.ok || !r.body) return canQuyet("không tải được: HTTP " + r.status);

  // Tải ra .tam rồi mới đổi tên. Tải thẳng ra tên thật mà đứt mạng là để lại file
  // cụt; lần chạy sau thấy đúng tên thì coi như xong, và bản vẽ hỏng nằm lại vĩnh
  // viễn — cùng loại bẫy với "file copy dở" của day-len, chỉ là chiều ngược lại.
  // Tên file tạm phải bắt đầu bằng DẤU CHẤM. day-len.quetThuMuc() bỏ qua mọi tên
  // bắt đầu bằng "." — không có dấu chấm đó thì một lần tải bị giết giữa chừng sẽ
  // để lại "ban-ve.pdf.bim-tam" trong thư mục cột, và lần chạy sau day-len coi nó
  // là bản vẽ mới rồi ĐẨY BẢN TẢI DỞ LÊN WEB.
  const tam = path.join(duongDanCot, "." + ten + ".bim-tam");
  let daGhi = 0;
  try {
    const nguon = Readable.fromWeb(r.body);
    nguon.on("data", (c) => { daGhi += c.length; });
    await pipeline(nguon, createWriteStream(boc(tam)));
  } catch (e) {
    await fsp.unlink(boc(tam)).catch(() => {});
    return canQuyet("tải dở dang: " + e.message);
  }

  const mong = Number(fileBang.size) || 0;
  if (mong && daGhi !== mong) {
    await fsp.unlink(boc(tam)).catch(() => {});
    return canQuyet(`tải về thiếu byte (${daGhi}/${mong}) — đã bỏ file dở, sẽ thử lại lần sau`);
  }

  // Kiểm lại lần nữa ngay trước khi đổi tên: máy khác có thể vừa thả file vào.
  if (await fsp.stat(boc(dich)).catch(() => null)) {
    await fsp.unlink(boc(tam)).catch(() => {});
    return canQuyet("vừa có file cùng tên xuất hiện trong lúc tải — không ghi đè");
  }
  try { await fsp.rename(boc(tam), boc(dich)); }
  catch (e) {
    await fsp.unlink(boc(tam)).catch(() => {});
    return canQuyet("không đổi tên được file tạm: " + e.message);
  }
  return { ok: true, duongDan: dich, canQuyet: null, size: daGhi };
}
