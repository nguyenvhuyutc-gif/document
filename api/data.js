// ============================================================
//  API dữ liệu — NHIỀU KẾ HOẠCH, mỗi kế hoạch = 1 document MongoDB
//    GET  /api/data?list=1                 -> { ok, plans: [{id,name,mtime}] }
//    GET  /api/data?plan=<id>              -> { ok, mtime, data, name }
//    POST /api/data?plan=<id>   (body=data)-> lưu, trả { ok, mtime }
//    POST /api/data?action=create&name=…   -> { ok, plan: {id,name,mtime} }
//    POST /api/data?action=rename&plan=&name=…
//    POST /api/data?action=delete&plan=
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

    // Ghi (POST/DELETE) cần quyền: sửa thường cần EDIT_KEY, xoá kế hoạch cần ADMIN_KEY
    if (req.method === "POST" || req.method === "DELETE") {
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
