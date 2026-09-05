// ============================================================
//  API dữ liệu — NHIỀU KẾ HOẠCH, mỗi kế hoạch = 1 document MongoDB
//    GET  /api/data?list=1                 -> { ok, plans: [{id,name,mtime}] }
//    GET  /api/data?plan=<id>              -> { ok, mtime, data, name }
//    POST /api/data?plan=<id>   (body=data)-> lưu, trả { ok, mtime }
//    POST /api/data?action=create&name=…   -> { ok, plan: {id,name,mtime} }
//    POST /api/data?action=rename&plan=&name=…
//    POST /api/data?action=delete&plan=
//    POST /api/data?action=tvgs&plan=&row=  (body={files:[…]}) -> vá RIÊNG cột
//         "Ý kiến TVGS" của một dòng. Endpoint DUY NHẤT không đòi mật khẩu.
//  Tương thích ngược: doc cũ _id="data" hiện ra như một kế hoạch tên "Kế hoạch 1".
// ============================================================
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "bim";
const collectionName = process.env.MONGODB_COLLECTION || "bim_app";

function sendJson(res, code, obj) {
  res.status(code).json(obj);
}

// Cột "Ý kiến TVGS" mở cho MỌI người, kể cả không có mật khẩu: bên tư vấn giám sát
// cần gửi ý kiến mà không cầm mật khẩu của chủ đầu tư. Họ KHÔNG ghi cả document —
// chỉ gọi được `?action=tvgs` bên dưới, thứ chỉ đụng đúng một mảng của đúng một dòng.
// Tên cột phải khớp FKEYS ở bang-hang-muc.html và api/files.js.
const COT_TU_DO = "filesTvgs";
const MAX_FILE_TVGS = 200;          // trần số file một dòng, chặn nhồi rác

// ---- phân quyền: EDIT_KEY = được sửa/tải file, ADMIN_KEY = thêm quyền xoá ----
// Chưa đặt cả hai biến môi trường → không khoá gì (tương thích bản cũ).
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function getRole(req) {
  const adminKey = process.env.ADMIN_KEY || "";
  const editKey = process.env.EDIT_KEY || "";
  if (!adminKey && !editKey) return "admin";
  const key = String(req.headers["x-edit-key"] || "");
  if (adminKey && key && safeEqual(key, adminKey)) return "admin";
  if (editKey && key && safeEqual(key, editKey)) return "edit";
  return "view";
}
function isProtected() {
  return !!(process.env.ADMIN_KEY || process.env.EDIT_KEY);
}

// Lọc một mục file do client gửi lên về đúng những trường mình biết. KHÔNG lưu
// nguyên vật client gửi: người không mật khẩu cũng gọi được endpoint này, nhét
// trường lạ vào document kế hoạch là mở đường cho đủ thứ về sau.
function locFileTvgs(f) {
  if (!f || typeof f !== "object") return null;
  const id = String(f.id || "");
  if (!id) return null;
  const ra = {
    id,
    uid: String(f.uid || id).slice(0, 64),
    name: String(f.name || "file").slice(0, 300),
    size: Number(f.size) >= 0 ? Number(f.size) : 0,
    type: String(f.type || "application/octet-stream").slice(0, 120),
    url: "api/files?id=" + id,       // dựng lại, không nhận url do client đưa
    uploadedAt: String(f.uploadedAt || "").slice(0, 40),
    note: String(f.note || "").slice(0, 4000),
    pairUid: String(f.pairUid || "").slice(0, 64),
  };
  return ra;
}

async function connectMongo() {
  if (!uri) throw new Error("MONGODB_URI is not configured");
  if (global.__mongoClient && global.__mongoDb) {
    return { client: global.__mongoClient, db: global.__mongoDb };
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  global.__mongoClient = client;
  global.__mongoDb = db;
  return { client, db };
}

async function readBody(req) {
  if (req.body != null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = req.body;
  if (raw == null) {
    raw = await new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
  return JSON.parse(raw);
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams;

    // ---- kiểm tra quyền của mật khẩu gửi kèm (không cần DB) ----
    if (req.method === "GET" && q.get("whoami")) {
      return sendJson(res, 200, { ok: true, role: getRole(req), protected: isProtected() });
    }

    // Ghi (POST/DELETE) cần quyền: sửa thường cần EDIT_KEY, xoá kế hoạch cần ADMIN_KEY.
    // NGOẠI LỆ DUY NHẤT: `?action=tvgs` — xem khối xử lý bên dưới. Nó không nhận cả
    // document mà chỉ thay đúng một mảng của đúng một dòng, nên mở cho mọi người mà
    // không cho ai sửa được gì khác.
    if ((req.method === "POST" || req.method === "DELETE") && q.get("action") !== "tvgs") {
      const role = getRole(req);
      const isDelete = req.method === "DELETE" || q.get("action") === "delete";
      if (isDelete && role !== "admin") {
        return sendJson(res, 401, { ok: false, needKey: true, error: "Cần mật khẩu quản trị để xoá" });
      }
      if (role !== "admin" && role !== "edit") {
        return sendJson(res, 401, { ok: false, needKey: true, error: "Cần mật khẩu quyền sửa" });
      }
    }

    const { db } = await connectMongo();
    const collection = db.collection(collectionName);

    // ---- danh sách kế hoạch ----
    if (req.method === "GET" && q.get("list")) {
      const docs = await collection.find({}, { projection: { name: 1, updatedAt: 1, createdAt: 1 } }).toArray();
      const plans = docs.map((d) => ({
        id: d._id,
        name: d.name || "Kế hoạch 1",
        mtime: d.updatedAt || 0,
        createdAt: d.createdAt || 0,
      }));
      plans.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      return sendJson(res, 200, { ok: true, plans });
    }

    const action = q.get("action");

    // ---- tạo kế hoạch ----
    if (req.method === "POST" && action === "create") {
      const name = (q.get("name") || "Kế hoạch mới").trim().slice(0, 120) || "Kế hoạch mới";
      const id = "p" + crypto.randomBytes(8).toString("hex");
      const now = Date.now();
      await collection.insertOne({ _id: id, name, data: null, createdAt: now, updatedAt: now });
      return sendJson(res, 200, { ok: true, plan: { id, name, mtime: now } });
    }

    // ---- đổi tên ----
    if (req.method === "POST" && action === "rename") {
      const id = q.get("plan");
      const name = (q.get("name") || "").trim().slice(0, 120);
      if (!id || !name) return sendJson(res, 400, { ok: false, error: "Thiếu plan hoặc name" });
      await collection.updateOne({ _id: id }, { $set: { name } });
      return sendJson(res, 200, { ok: true });
    }

    // ---- xoá ----
    if ((req.method === "POST" && action === "delete") || (req.method === "DELETE" && q.get("plan"))) {
      const id = q.get("plan");
      if (!id) return sendJson(res, 400, { ok: false, error: "Thiếu plan" });
      await collection.deleteOne({ _id: id });
      return sendJson(res, 200, { ok: true });
    }

    // ---- ghi RIÊNG cột "Ý kiến TVGS" của một dòng (mở cho mọi quyền) ----
    //   POST /api/data?action=tvgs&plan=<id>&row=<rowId>   body = { files: [...] }
    //
    // Vì sao không để bên TVGS dùng chung đường ghi thường: đường đó nhận CẢ document
    // và ghi đè, nên mở nó ra là mở luôn quyền sửa mọi thứ. Ở đây client không quyết
    // được gì ngoài nội dung một mảng, và từng mục còn phải là file đã tải lên ĐÚNG
    // cột này (kiểm bằng cờ `cot` mà api/files.js đóng lúc ký URL, không tin client).
    if (req.method === "POST" && action === "tvgs") {
      const planId2 = q.get("plan");
      const rowId = q.get("row");
      if (!planId2 || !rowId) return sendJson(res, 400, { ok: false, error: "Thiếu plan hoặc row" });

      let payload2;
      try { payload2 = await readBody(req); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "JSON không hợp lệ" }); }
      const gui = payload2 && Array.isArray(payload2.files) ? payload2.files : null;
      if (!gui) return sendJson(res, 400, { ok: false, error: "Thiếu danh sách file" });
      if (gui.length > MAX_FILE_TVGS) {
        return sendJson(res, 413, { ok: false, error: "Quá nhiều file trong một dòng" });
      }

      const sach = gui.map(locFileTvgs).filter(Boolean);
      if (sach.length !== gui.length) {
        return sendJson(res, 400, { ok: false, error: "Danh sách file có mục không hợp lệ" });
      }

      // Mọi id phải là file đã tải lên đúng cột này. Thiếu bước này thì ai cũng nhét
      // được id của file ở cột khác vào đây — và xoá nó qua đường thùng rác của khách.
      if (sach.length) {
        const filesCol = db.collection(process.env.MONGODB_FILES_COLLECTION || "bim_files");
        const docs = await filesCol
          .find({ _id: { $in: sach.map((f) => f.id) } })
          .project({ cot: 1 })
          .toArray();
        const hopLe = new Set(docs.filter((d) => d.cot === COT_TU_DO).map((d) => String(d._id)));
        if (sach.some((f) => !hopLe.has(f.id))) {
          return sendJson(res, 403, { ok: false, error: "Có file không thuộc cột Ý kiến TVGS" });
        }
      }

      // Lấy luôn danh sách id các dòng: phải biết dòng có thật hay không TRƯỚC khi
      // ghi. Lệnh $set bên dưới luôn kèm `updatedAt`, nên `modifiedCount` luôn khác 0
      // kể cả khi arrayFilters không khớp dòng nào — không thể dựa vào nó để phát
      // hiện dòng lạ. Thiếu chốt này thì gọi với row bịa vẫn trả "thành công" và đẩy
      // mtime, mà endpoint này KHÔNG đòi mật khẩu: một vòng lặp curl là cả nhóm bị
      // đồng bộ lại liên tục.
      const cur2 = await collection.findOne(
        { _id: planId2 },
        { projection: { updatedAt: 1, "data.rows.id": 1 } }
      );
      if (!cur2) return sendJson(res, 404, { ok: false, error: "Không tìm thấy kế hoạch" });
      const dsDong = (cur2.data && Array.isArray(cur2.data.rows)) ? cur2.data.rows : [];
      if (!dsDong.some((d) => d && String(d.id) === String(rowId))) {
        return sendJson(res, 404, { ok: false, error: "Không tìm thấy dòng" });
      }

      let t2 = Date.now();
      if (t2 <= (cur2.updatedAt || 0)) t2 = (cur2.updatedAt || 0) + 1;   // mtime phải tăng thật
      // arrayFilters: sửa đúng dòng có id đó, ngay trong máy chủ. Không đọc-sửa-ghi cả
      // document ở client nên không có cửa sổ nào để ghi đè thay đổi của người khác.
      // Điều kiện updatedAt giữ cho mtime không lùi khi hai người bấm cùng lúc.
      const r2 = await collection.updateOne(
        { _id: planId2, updatedAt: cur2.updatedAt || 0 },
        { $set: { ["data.rows.$[dong]." + COT_TU_DO]: sach, updatedAt: t2 } },
        { arrayFilters: [{ "dong.id": String(rowId) }] }
      );
      if (!r2.matchedCount) {
        // Có người vừa lưu xen vào — client đọc lại rồi thử lại, y như nhánh 409 dưới.
        const lai = await collection.findOne({ _id: planId2 });
        return sendJson(res, 409, {
          ok: false, conflict: true,
          mtime: lai ? (lai.updatedAt || 0) : 0,
          data: lai ? (lai.data || null) : null,
        });
      }
      if (!r2.modifiedCount) return sendJson(res, 404, { ok: false, error: "Không tìm thấy dòng" });
      return sendJson(res, 200, { ok: true, mtime: t2 });
    }

    // ---- đọc / ghi dữ liệu một kế hoạch (mặc định: doc cũ "data") ----
    const planId = q.get("plan") || "data";

    if (req.method === "GET") {
      const doc = await collection.findOne({ _id: planId });
      if (!doc) return sendJson(res, 200, { ok: true, mtime: 0, data: null, name: null });
      return sendJson(res, 200, { ok: true, mtime: doc.updatedAt || 0, data: doc.data || null, name: doc.name || null });
    }

    if (req.method === "POST") {
      let payload;
      try { payload = await readBody(req); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "JSON không hợp lệ" }); }
      if (typeof payload !== "object" || payload === null) {
        return sendJson(res, 400, { ok: false, error: "Dữ liệu phải là JSON" });
      }
      const ifMtime = Number(q.get("ifMtime") || 0);
      let updatedAt = Date.now();
      // mtime phải TĂNG THẬT SỰ sau mỗi lần ghi. Hai lần ghi rơi vào cùng một
      // mili-giây sẽ sinh cùng một updatedAt, và điều kiện ifMtime của người lưu
      // kế tiếp sẽ khớp nhầm — ghi đè im lặng, đúng cái lỗi đang sửa. Hiếm trong
      // thực tế (save() có debounce 250ms) nhưng rẻ để chặn hẳn.
      if (updatedAt <= ifMtime) updatedAt = ifMtime + 1;

      // ifMtime = 0 → giữ nguyên hành vi cũ (upsert). Cần cho hai trường hợp:
      // kế hoạch mới chưa có document, và các tab đang mở bản HTML cũ trong cache
      // chưa biết gửi tham số này.
      if (!ifMtime) {
        await collection.updateOne(
          { _id: planId },
          { $set: { data: payload, updatedAt }, $setOnInsert: { name: "Kế hoạch 1", createdAt: updatedAt } },
          { upsert: true }
        );
        return sendJson(res, 200, { ok: true, mtime: updatedAt });
      }

      // Có ifMtime → chỉ ghi khi document trên máy chủ vẫn đúng bản mà client đã đọc.
      // Không có điều kiện này thì người lưu sau luôn thắng và mọi thay đổi của người
      // lưu trước biến mất không dấu vết: không cảnh báo, không nhật ký, không hoàn tác.
      const r = await collection.updateOne(
        { _id: planId, updatedAt: ifMtime },
        { $set: { data: payload, updatedAt } }
      );
      if (r.matchedCount === 1) return sendJson(res, 200, { ok: true, mtime: updatedAt });

      // Không khớp → có người khác đã lưu. KHÔNG ghi đè. Trả bản trên máy chủ về
      // để client có đủ thứ cần cho việc quyết định (xem bản mới, hay ghi đè).
      const cur = await collection.findOne({ _id: planId });
      return sendJson(res, 409, {
        ok: false,
        conflict: true,
        mtime: cur ? (cur.updatedAt || 0) : 0,
        data: cur ? (cur.data || null) : null,
      });
    }

    sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, error: String(error) });
  }
};
