// Kiểm phân quyền THẬT của cột "Ý kiến TVGS" — cột duy nhất mở cho người KHÔNG có
// mật khẩu. Đây là chỗ dễ hỏng nhất trong toàn bộ hệ phân quyền: một dòng sai ở
// api/data.js hoặc api/files.js là ai có link cũng sửa được bảng, mà giao diện thì
// trông vẫn bình thường. Không có cách nào kiểm chuyện này ngoài gọi thẳng vào API
// đang chạy — nên script này tồn tại, và phải chạy lại sau MỖI lần đụng vào phân
// quyền hoặc vào hai file API đó.
//
// Chạy từ thư mục gốc của dự án (nó đọc .env ở đó):
//   node scripts/thu-quyen-tvgs.mjs
//   $env:BASE="https://ban-thu.vercel.app"; node scripts/thu-quyen-tvgs.mjs
//
// CẢNH BÁO — script này GHI vào môi trường thật:
//   · tạo một document kế hoạch tạm mang tiền tố "zz-thu-tvgs-" trong MongoDB
//   · tải vài file cỡ chục byte lên S3
// Cả hai đều được dọn trong khối finally, và dòng cuối in ra số file còn sót (phải
// là 0). Nó KHÔNG đụng tới kế hoạch thật nào.
//
// Vì sao không kiểm trên bản preview: EDIT_KEY/ADMIN_KEY chỉ đặt cho môi trường
// Production. Trên preview không biến nào được đặt, mà thiết kế tương thích cũ coi
// "không đặt biến = không khoá gì" nên MỌI người thành admin — mọi phép kiểm ở đây
// sẽ xanh một cách vô nghĩa. Muốn kiểm được trên preview thì phải đặt hai biến đó
// cho môi trường Preview trước.
import fs from "node:fs";
import { MongoClient } from "mongodb";

// đổi đích bằng biến môi trường BASE để chạy được với bản thử
const GOC = process.env.BASE || "https://bvtc.vcijsc.com";

// ---- đọc .env, KHÔNG in giá trị ra màn hình ----
const env = {};
for (const d of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(d);
  if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}
const KEY_SUA = env.EDIT_KEY || "";
const KEY_QT = env.ADMIN_KEY || "";

let dat = 0, hong = 0;
const ok = (s) => { dat++; console.log("  ✓ " + s); };
const loi = (s, ct) => { hong++; console.log("  ✗ " + s + (ct ? "\n      → " + ct : "")); };

// gọi API; `key` = mật khẩu gửi kèm (rỗng = khách không mật khẩu)
async function api(duong, { method = "GET", key = "", body = null } = {}) {
  const h = {};
  if (key) h["x-edit-key"] = key;
  if (body != null) h["content-type"] = "application/json";
  const r = await fetch(GOC + duong, {
    method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: "manual",
  });
  let j = null;
  try { j = JSON.parse(await r.text()); } catch (e) { /* không phải JSON */ }
  return { ma: r.status, j };
}

const client = new MongoClient(env.MONGODB_URI);
const KE_HOACH_THU = "zz-thu-tvgs-" + Math.random().toString(36).slice(2, 10);
const DONG_THU = "dong-thu-1";
const donDep = [];        // id file cần xoá hẳn ở cuối

try {
  await client.connect();
  const db = client.db(env.MONGODB_DB || "bim");
  const colApp = db.collection(env.MONGODB_COLLECTION || "bim_app");
  const colFile = db.collection(env.MONGODB_FILES_COLLECTION || "bim_files");

  console.log("\n══ Phép thử quyền thật — " + GOC + " ══");
  console.log("  kế hoạch thử: " + KE_HOACH_THU + " (sẽ xoá ở cuối)\n");

  // ---------- 0. mật khẩu trong .env có còn đúng với production không ----------
  console.log("  ── 0. mật khẩu và vai trò ──");
  {
    const a = await api("/api/data?whoami=1");
    const b = await api("/api/data?whoami=1", { key: KEY_SUA });
    const c = await api("/api/data?whoami=1", { key: KEY_QT });
    if (a.j?.role === "view" && a.j?.protected === true) ok("không mật khẩu → vai trò 'view', khoá đang bật");
    else loi("vai trò khách sai", JSON.stringify(a.j));
    if (b.j?.role === "edit") ok("EDIT_KEY trong .env vẫn đúng với production");
    else loi("EDIT_KEY trong .env KHÔNG khớp production — các phép thử cần quyền sửa sẽ sai", JSON.stringify(b.j));
    if (c.j?.role === "admin") ok("ADMIN_KEY trong .env vẫn đúng với production");
    else loi("ADMIN_KEY trong .env KHÔNG khớp production", JSON.stringify(c.j));
  }

  // ---------- dựng kế hoạch thử ----------
  const now = Date.now();
  await colApp.insertOne({
    _id: KE_HOACH_THU,
    name: "ZZ thử nghiệm quyền TVGS (tự xoá)",
    data: {
      rows: [{
        id: DONG_THU, level: 0, collapsed: false, hidden: false,
        hangMuc: "dòng thử", chiTiet: "", nguoiLam: [], tienDo: "", tinhTrang: "", ghiChu: "",
        files: [], filesCad: [], filesTvgs: [], filesDuyet: [], filesChapThuan: [],
      }],
      people: ["Người thử"], statuses: [],
    },
    createdAt: now, updatedAt: now,
  });

  // ---------- 1 & 2. tải lên: cột nào mở, cột nào chặn ----------
  console.log("\n  ── 1 & 2. xin đường tải lên khi KHÔNG có mật khẩu ──");
  {
    // size vượt trần → nếu qua được cửa quyền sẽ nhận 413, còn bị chặn thì 401.
    // Nhờ mẹo này kiểm được cửa quyền mà không tạo ra document rác nào.
    const qua = await api("/api/files?action=sign-upload&name=t.pdf&type=application/pdf&size=999999999&cot=filesTvgs",
      { method: "POST" });
    if (qua.ma === 413) ok("cột filesTvgs: qua được cửa quyền (413 vì quá lớn, không phải 401)");
    else loi("cột filesTvgs bị chặn hoặc lỗi lạ", "HTTP " + qua.ma + " " + JSON.stringify(qua.j));

    for (const cot of ["files", "filesCad", "filesDuyet", "filesChapThuan", ""]) {
      const r = await api("/api/files?action=sign-upload&name=t.pdf&type=application/pdf&size=999999999&cot=" + cot,
        { method: "POST" });
      const ten = cot || "(không khai cột)";
      if (r.ma === 401) ok("cột " + ten + ": bị chặn 401 — đúng");
      else loi("cột " + ten + " HỞ cho người không mật khẩu", "HTTP " + r.ma + " " + JSON.stringify(r.j));
    }
  }

  // ---------- tải THẬT một file bé lên cột TVGS, không mật khẩu ----------
  console.log("\n  ── 1b. tải lên trọn vẹn (không mật khẩu, cột TVGS) ──");
  let idTvgs = null;
  {
    const noiDung = Buffer.from("thu nghiem tvgs\n");
    const s = await api("/api/files?action=sign-upload&name=y-kien-thu.txt&type=text/plain&size="
      + noiDung.length + "&cot=filesTvgs", { method: "POST" });
    if (s.ma !== 200 || !s.j?.uploadUrl) {
      loi("không xin được đường tải lên cho cột TVGS", "HTTP " + s.ma + " " + JSON.stringify(s.j));
    } else {
      idTvgs = s.j.id;
      donDep.push(s.j.id);
      const put = await fetch(s.j.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="y-kien-thu.txt"' },
        body: noiDung,
      });
      if (!put.ok) loi("PUT lên S3 thất bại", "HTTP " + put.status);
      else {
        const c = await api("/api/files?action=confirm&id=" + s.j.id + "&key=" + encodeURIComponent(s.j.key),
          { method: "POST" });
        if (c.ma === 200 && c.j?.file?.id) ok("không mật khẩu: tải file lên cột TVGS TRỌN VẸN (ký → PUT → xác nhận)");
        else loi("xác nhận thất bại", "HTTP " + c.ma + " " + JSON.stringify(c.j));
      }
    }
  }

  // ---------- 3. action=tvgs chỉ được đụng đúng mảng filesTvgs ----------
  console.log("\n  ── 3. ?action=tvgs có sửa được gì ngoài cột TVGS không ──");
  {
    const truoc = await colApp.findOne({ _id: KE_HOACH_THU });
    const r = await api("/api/data?action=tvgs&plan=" + KE_HOACH_THU + "&row=" + DONG_THU, {
      method: "POST",
      body: {
        // nhét thêm mọi thứ xem có lọt không
        rows: [{ id: DONG_THU, hangMuc: "ĐÃ BỊ CHIẾM" }],
        people: ["kẻ lạ"], statuses: [{ id: "x", name: "chiếm", color: "#000" }],
        name: "tên bị đổi",
        files: idTvgs ? [{
          id: idTvgs, uid: "u1", name: "y-kien-thu.txt", size: 16, type: "text/plain",
          url: "https://ke-la.example/doc-hai",        // url giả — phải bị dựng lại
          note: "ý kiến thử", pairUid: "",
          hack: "trường lạ", __proto__x: 1,             // trường lạ — phải bị bỏ
        }] : [],
      },
    });
    const sau = await colApp.findOne({ _id: KE_HOACH_THU });
    if (r.ma === 200 && r.j?.ok) ok("ghi cột TVGS không cần mật khẩu: được (HTTP 200)");
    else loi("ghi cột TVGS không mật khẩu bị lỗi", "HTTP " + r.ma + " " + JSON.stringify(r.j));

    const d = sau?.data?.rows?.[0] || {};
    if (d.hangMuc === "dòng thử") ok("hangMuc của dòng KHÔNG bị đổi");
    else loi("hangMuc bị ghi đè — LỖ HỔNG", String(d.hangMuc));
    if (JSON.stringify(sau?.data?.people) === JSON.stringify(truoc?.data?.people)) ok("people KHÔNG bị đụng");
    else loi("people bị ghi đè — LỖ HỔNG", JSON.stringify(sau?.data?.people));
    if (JSON.stringify(sau?.data?.statuses) === JSON.stringify(truoc?.data?.statuses)) ok("statuses KHÔNG bị đụng");
    else loi("statuses bị ghi đè — LỖ HỔNG", JSON.stringify(sau?.data?.statuses));
    if (sau?.name === truoc?.name) ok("tên kế hoạch KHÔNG bị đổi");
    else loi("tên kế hoạch bị đổi — LỖ HỔNG", String(sau?.name));
    if (JSON.stringify(d.files) === "[]" && JSON.stringify(d.filesCad) === "[]") ok("các cột file khác vẫn rỗng");
    else loi("cột file khác bị ghi — LỖ HỔNG", JSON.stringify({ files: d.files, filesCad: d.filesCad }));

    const f = (d.filesTvgs || [])[0];
    if (idTvgs) {
      if (f && f.id === idTvgs) ok("file hợp lệ được ghi vào đúng cột TVGS");
      else loi("không ghi được file vào cột TVGS", JSON.stringify(d.filesTvgs));
      if (f && f.url === "api/files?id=" + idTvgs) ok("url do client bịa bị DỰNG LẠI, không lưu nguyên");
      else loi("url của client được lưu nguyên — LỖ HỔNG", String(f?.url));
      if (f && f.hack === undefined) ok("trường lạ của client bị loại bỏ");
      else loi("trường lạ lọt vào document — LỖ HỔNG", JSON.stringify(f));
    }
  }

  // ---------- 3b. file của cột khác không nhét vào cột TVGS được ----------
  console.log("\n  ── 3b. nhét file cột khác vào cột TVGS ──");
  {
    // tải một file lên cột filesCad BẰNG QUYỀN SỬA, rồi thử nhét id đó vào TVGS
    const noiDung = Buffer.from("file cot khac\n");
    const s = await api("/api/files?action=sign-upload&name=ban-ve.txt&type=text/plain&size="
      + noiDung.length + "&cot=filesCad", { method: "POST", key: KEY_SUA });
    if (s.ma !== 200) {
      loi("không tải được file cột khác để thử (bỏ qua ca này)", "HTTP " + s.ma);
    } else {
      donDep.push(s.j.id);
      await fetch(s.j.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="ban-ve.txt"' },
        body: noiDung,
      });
      await api("/api/files?action=confirm&id=" + s.j.id + "&key=" + encodeURIComponent(s.j.key),
        { method: "POST", key: KEY_SUA });

      const r = await api("/api/data?action=tvgs&plan=" + KE_HOACH_THU + "&row=" + DONG_THU, {
        method: "POST",
        body: { files: [{ id: s.j.id, name: "ban-ve.txt", size: 14, type: "text/plain" }] },
      });
      if (r.ma === 403) ok("nhét file cột DWG vào cột TVGS: bị chặn 403 — đúng");
      else loi("file cột khác LỌT vào cột TVGS — LỖ HỔNG", "HTTP " + r.ma + " " + JSON.stringify(r.j));

      // và thử xoá nó bằng đường thùng rác của khách, giả fkey
      const t = await api("/api/files?action=trash", {
        method: "POST",
        body: { items: [{ id: s.j.id, planId: KE_HOACH_THU, rowId: DONG_THU, fkey: "filesTvgs", rowName: "giả" }] },
      });
      if (t.ma === 401) ok("giả fkey để xoá file cột DWG: bị chặn 401 — đúng");
      else loi("giả fkey xoá được file cột khác — LỖ HỔNG NẶNG", "HTTP " + t.ma + " " + JSON.stringify(t.j));
    }
  }

  // ---------- 4. plan lạ / row lạ ----------
  console.log("\n  ── 4. kế hoạch lạ / dòng lạ có sinh rác không ──");
  {
    const laId = "zz-khong-ton-tai-" + Math.random().toString(36).slice(2, 8);
    const r = await api("/api/data?action=tvgs&plan=" + laId + "&row=x", { method: "POST", body: { files: [] } });
    const con = await colApp.findOne({ _id: laId });
    if (r.ma === 404) ok("kế hoạch không tồn tại → 404");
    else loi("kế hoạch lạ trả mã lạ", "HTTP " + r.ma + " " + JSON.stringify(r.j));
    if (!con) ok("kế hoạch lạ KHÔNG bị tạo ra (không sinh dữ liệu rác)");
    else { loi("đã tạo document rác cho kế hoạch lạ — LỖ HỔNG"); await colApp.deleteOne({ _id: laId }); }

    const truoc = await colApp.findOne({ _id: KE_HOACH_THU });
    const r2 = await api("/api/data?action=tvgs&plan=" + KE_HOACH_THU + "&row=dong-khong-co", {
      method: "POST", body: { files: [] },
    });
    const sau = await colApp.findOne({ _id: KE_HOACH_THU });
    const soDong = sau?.data?.rows?.length;
    if (soDong === 1) ok("dòng không tồn tại: KHÔNG chèn thêm dòng nào vào bảng");
    else loi("dòng lạ làm phát sinh dòng trong bảng — LỖ HỔNG", "số dòng = " + soDong);
    if (r2.ma === 404) ok("dòng không tồn tại → 404");
    else loi("dòng không tồn tại mà KHÔNG báo lỗi", "HTTP " + r2.ma + " " + JSON.stringify(r2.j));
    // Chốt riêng cho mtime: endpoint này KHÔNG đòi mật khẩu, nên nếu một request
    // hỏng vẫn đẩy được mtime thì ai cũng bắt cả nhóm đồng bộ lại bằng một vòng lặp
    // curl — không tốn byte nào, không để lại file nào. Đã từng sập đúng chỗ này:
    // `modifiedCount` luôn khác 0 vì $set kèm updatedAt, nên không dùng nó để bắt lỗi được.
    if (sau?.updatedAt === truoc?.updatedAt) ok("dòng không tồn tại: mtime GIỮ NGUYÊN, không bắt cả nhóm đồng bộ lại");
    else loi("request hỏng vẫn đẩy mtime — ai cũng làm phiền cả nhóm bằng vòng lặp curl",
      "updatedAt " + truoc?.updatedAt + " → " + sau?.updatedAt);
  }

  // ---------- 5. trần số file ----------
  console.log("\n  ── 5. trần 200 file một dòng ──");
  {
    const nhieu = Array.from({ length: 201 }, (_, i) => ({ id: "x" + i, name: "f" + i }));
    const r = await api("/api/data?action=tvgs&plan=" + KE_HOACH_THU + "&row=" + DONG_THU,
      { method: "POST", body: { files: nhieu } });
    if (r.ma === 413) ok("gửi 201 file: bị chặn 413 — đúng");
    else loi("trần MAX_FILE_TVGS không chặn", "HTTP " + r.ma + " " + JSON.stringify(r.j));
  }

  // ---------- 6. thùng rác vẫn của riêng quản trị ----------
  console.log("\n  ── 6. thùng rác khi KHÔNG có mật khẩu ──");
  {
    const a = await api("/api/files?trash=1&plan=" + KE_HOACH_THU);
    if (a.ma === 401) ok("xem thùng rác: 401 — đúng");
    else loi("thùng rác mở cho người không mật khẩu — LỖ HỔNG", "HTTP " + a.ma);

    const b = await api("/api/files?action=restore&id=" + (idTvgs || "x"), { method: "POST" });
    if (b.ma === 401) ok("khôi phục: 401 — đúng");
    else loi("khôi phục mở cho người không mật khẩu — LỖ HỔNG", "HTTP " + b.ma);

    const c = await api("/api/files?id=" + (idTvgs || "x"), { method: "DELETE" });
    if (c.ma === 401) ok("xoá vĩnh viễn: 401 — đúng");
    else loi("xoá vĩnh viễn mở cho người không mật khẩu — LỖ HỔNG", "HTTP " + c.ma);

    const d = await api("/api/data?plan=" + KE_HOACH_THU, { method: "POST", body: { rows: [] } });
    if (d.ma === 401) ok("ghi cả bảng: 401 — đúng (chỉ ?action=tvgs mới mở)");
    else loi("ghi cả bảng LỌT cho người không mật khẩu — LỖ HỔNG NẶNG", "HTTP " + d.ma);
  }

  // ---------- 7. xoá file TVGS không mật khẩu → vào thùng rác, không mất hẳn ----------
  console.log("\n  ── 7. xoá file TVGS khi không có mật khẩu ──");
  if (idTvgs) {
    const t = await api("/api/files?action=trash", {
      method: "POST",
      body: { items: [{ id: idTvgs, planId: KE_HOACH_THU, rowId: DONG_THU, fkey: "filesTvgs", rowName: "dòng thử", note: "ý kiến thử" }] },
    });
    const doc = await colFile.findOne({ _id: idTvgs });
    if (t.ma === 200 && t.j?.trashed === 1) ok("không mật khẩu: bỏ được file TVGS vào thùng rác");
    else loi("không bỏ được vào thùng rác", "HTTP " + t.ma + " " + JSON.stringify(t.j));
    if (doc?.status === "trashed") ok("file chuyển sang trạng thái 'trashed', KHÔNG bị xoá hẳn");
    else loi("trạng thái file sau khi xoá không đúng", String(doc?.status));
    if (doc?.key) ok("object trên S3 vẫn còn (khôi phục được trong 30 ngày)");
    else loi("mất key S3 — không khôi phục được");
    if (doc?.origin?.note === "ý kiến thử") ok("ghi chú của file được giữ lại để khôi phục");
    else loi("mất ghi chú khi vào thùng rác", JSON.stringify(doc?.origin));

    const tai = await api("/api/files?id=" + idTvgs);
    if (tai.ma === 401 || tai.ma === 404) ok("file trong thùng rác: người không mật khẩu KHÔNG tải xuống được");
    else loi("file trong thùng rác vẫn tải tự do được", "HTTP " + tai.ma);
  } else {
    loi("không có file TVGS để thử xoá (bước 1b hỏng)");
  }
} finally {
  // ---------- DỌN ----------
  console.log("\n  ── dọn dẹp ──");
  try {
    for (const id of donDep) {
      const r = await api("/api/files?id=" + id, { method: "DELETE", key: KEY_QT });
      console.log("    xoá hẳn file " + id + ": HTTP " + r.ma);
    }
    const db = client.db(env.MONGODB_DB || "bim");
    const x = await db.collection(env.MONGODB_COLLECTION || "bim_app").deleteOne({ _id: KE_HOACH_THU });
    console.log("    xoá kế hoạch thử: " + (x.deletedCount ? "xong" : "KHÔNG THẤY (kiểm tay!)"));
    const con = await db.collection(env.MONGODB_FILES_COLLECTION || "bim_files")
      .countDocuments({ _id: { $in: donDep } });
    console.log("    file thử còn sót trong DB: " + con);
  } catch (e) {
    console.log("    LỖI khi dọn: " + (e?.message || e) + " — cần kiểm tay!");
  }
  await client.close();
}

console.log("\n  ════ " + dat + " đạt, " + hong + " hỏng ════\n");
process.exit(hong ? 1 : 0);
