// ============================================================
//  API file đính kèm — file lưu ở Cloudflare R2, MongoDB chỉ giữ metadata.
//
//  TẢI LÊN (3 bước, client đẩy thẳng lên R2, function chỉ ký URL):
//   POST /api/files?action=sign-upload&name=&type=&size=   (cần EDIT_KEY)
//        -> ghi doc {status:"pending"}, trả { ok, id, key, uploadUrl }
//   (client tự PUT thẳng lên uploadUrl, KÈM header Content-Disposition + Content-Type)
//   POST /api/files?action=confirm&id=&key=                (cần EDIT_KEY)
//        -> xác minh bằng HEAD trên R2, chuyển pending -> ready
//        -> { ok, file: { id, name, size, type, url } }
//
//  TẢI XUỐNG (tự do, không cần mật khẩu):
//   GET  /api/files?id=<id>          -> file mới: 302 sang R2 (URL ký, 5 phút)
//                                    -> file cũ:  trả thẳng từ MongoDB như trước
//   GET  /api/files?id=<id>&part=<i> -> mảnh thứ i của file cũ chia mảnh
//
//   DELETE /api/files?id=<id>        -> xoá object R2 + doc (cần ADMIN_KEY)
//
//  File CŨ (nguyên khối `data`, hoặc chia mảnh `chunks`) vẫn đọc từ MongoDB —
//  không migrate, không đụng tới. Đường đọc đó KHÔNG bao giờ chạm tới R2, nên
//  thiếu biến môi trường R2 cũng không làm hỏng việc tải file cũ.
// ============================================================
const { MongoClient } = require("mongodb");
const crypto = require("crypto");
const { AwsClient } = require("aws4fetch");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "bim";
const filesCollection = process.env.MONGODB_FILES_COLLECTION || "bim_files";

const MAX_UPLOAD = 200 * 1024 * 1024;       // giới hạn 1 file (R2 không giới hạn, đây là chính sách)

// ---- phân quyền (giống api/data.js): EDIT_KEY = tải file lên, ADMIN_KEY = thêm quyền xoá ----
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

// ---- Cloudflare R2 ----
// KHỞI TẠO LƯỜI, đúng nếp connectMongo() ở trên.
// KHÔNG dựng AwsClient ở tầng module: nếu 4 biến R2 thiếu hoặc RỖNG (bẫy đã biết
// của `vercel env add`, xem .claude/skills/deploy-bim/SKILL.md) thì hoặc là module
// ném lỗi lúc nạp và TOÀN BỘ /api/files trả 500 — kể cả GET file cũ trong MongoDB,
// thứ mà đường lai sinh ra để bảo vệ — hoặc là base URL thành
// "https://undefined.r2.…/undefined" và sign-upload trả 200 với URL trông hợp lệ,
// đẩy lỗi xuống tận xhr.onerror ở client dưới dạng "mất kết nối khi tải lên".
let _r2 = null;
function getR2() {
  if (_r2) return _r2;
  const miss = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    .filter((k) => !process.env[k]);
  if (miss.length) throw new Error("Thiếu biến môi trường R2: " + miss.join(", "));
  _r2 = {
    client: new AwsClient({
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    }),
    base: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}`,
  };
  return _r2;
}

// Ký URL có hạn. signQuery: true → chữ ký nằm trong query string, và aws4fetch
// chỉ ký đúng header `host` (X-Amz-SignedHeaders=host). Nhờ đó client gửi thêm
// Content-Disposition / Content-Type lúc PUT cũng không làm lệch chữ ký, mà R2
// vẫn lưu chúng làm metadata của object.
//
// LƯU Ý: method là DÒNG ĐẦU TIÊN của canonical request trong SigV4 — URL ký cho
// "GET" KHÔNG dùng được cho "HEAD". Mỗi method phải ký riêng.
//
// KHÔNG thêm response-content-disposition / response-content-type vào query:
// aws4fetch dựng canonical query bằng encodeRfc3986(encodeURIComponent(v))
// (space → %20, * → %2A) còn URL gửi đi lấy từ URL.toString() (space → +, * → *).
// Chuỗi Content-Disposition chứa cả hai ký tự đó → chữ ký lệch → 403 mọi file.
async function signR2(key, method, expires) {
  const { client, base } = getR2();
  const u = new URL(`${base}/${key}`);
  u.searchParams.set("X-Amz-Expires", String(expires));
  const signed = await client.sign(u.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

// bim/2026-09/a1b2c3d4e5f6.dwg — chỉ ASCII.
// Tên thật (có dấu) lưu ở MongoDB và trong Content-Disposition của object,
// KHÔNG nhét vào key — tránh hẳn một lớp lỗi mã hoá trong chữ ký.
function makeKey(name) {
  const ym = new Date().toISOString().slice(0, 7);
  const rand = crypto.randomBytes(6).toString("hex");
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""));
  return `bim/${ym}/${rand}${m ? "." + m[1].toLowerCase() : ""}`;
}
const KEY_RE = /^bim\/\d{4}-\d{2}\/[0-9a-f]{12}(\.[a-z0-9]{1,8})?$/;

function docBuffer(doc) {
  return doc.data && doc.data.buffer ? Buffer.from(doc.data.buffer) : Buffer.from(doc.data || "");
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    const action = url.searchParams.get("action");

    // ---- Shim cho HTML cũ còn nằm trong cache trình duyệt ----
    // bang-hang-muc.html là file tĩnh và vercel.json chỉ đặt header cho /api/(.*),
    // nên không có gì ép tab đang mở tải lại. Không có shim này thì request rơi
    // xuống 405 "Method Not Allowed" — chuỗi tiếng Anh khó hiểu, hiện ra sau khi
    // retryUp đã thử lại 3 lần mỗi mảnh, tức là treo ô nhiều phút.
    // Đặt TRƯỚC cả bước kiểm quyền: người dùng cần biết "hãy tải lại trang",
    // không phải "sai mật khẩu".
    //
    // Bắt theo kiểu "mọi POST KHÔNG phải sign-upload/confirm" chứ không liệt kê
    // action cũ: bản cũ tải file nhỏ (≤3.5MB) bằng POST ?name=&type= KHÔNG có
    // action nào cả — đó là đường tải lên phổ biến nhất, và liệt kê theo tên sẽ
    // bỏ sót đúng nó.
    const postLaCu = req.method === "POST" && action !== "sign-upload" && action !== "confirm";
    if (postLaCu || (req.method === "DELETE" && url.searchParams.get("chunks"))) {
      res.status(426).json({ ok: false, error: "Bản web đã cập nhật — hãy tải lại trang (Ctrl+F5)" });
      return;
    }

    // Tải xuống (GET) tự do; tải lên (POST) cần EDIT_KEY; xoá (DELETE) cần ADMIN_KEY
    if (req.method === "POST" || req.method === "DELETE") {
      const role = getRole(req);
      if (req.method === "DELETE" && role !== "admin") {
        res.status(401).json({ ok: false, needKey: true, error: "Cần mật khẩu quản trị để xoá file" });
        return;
      }
      if (role !== "admin" && role !== "edit") {
        res.status(401).json({ ok: false, needKey: true, error: "Cần mật khẩu quyền sửa để tải file lên" });
        return;
      }
    }

    const { db } = await connectMongo();
    const col = db.collection(filesCollection);

    // ---- Bước 1: xin URL để tải thẳng lên R2 ----
    if (req.method === "POST" && action === "sign-upload") {
      const name = url.searchParams.get("name") || "file";
      const type = url.searchParams.get("type") || "application/octet-stream";
      const size = Number(url.searchParams.get("size"));
      // Tách 400 và 413: báo "quá lớn" khi thật ra thiếu tham số sẽ dẫn debug đi sai hướng.
      if (!Number.isFinite(size) || size <= 0) {
        res.status(400).json({ ok: false, error: "Thiếu hoặc sai tham số size" });
        return;
      }
      if (size > MAX_UPLOAD) {
        res.status(413).json({ ok: false, error: "File quá lớn (giới hạn 200MB)" });
        return;
      }

      const key = makeKey(name);
      const newId = crypto.randomBytes(12).toString("hex");
      // KÝ TRƯỚC, ghi doc SAU. Ký là tính toán cục bộ, không gọi mạng, nhưng nó
      // ném lỗi khi 4 biến R2 thiếu hoặc rỗng. Ghi doc trước thì mỗi lần thử sẽ
      // để lại một doc `pending` mồ côi — và retryUp ở client thử 3 lần, còn script
      // dọn thì CỐ Ý không bao giờ đụng tới doc pending. Ký trước thì lỗi xảy ra
      // khi chưa có gì được ghi và chưa ai nhận được URL nào.
      const uploadUrl = await signR2(key, "PUT", 900);       // 15 phút
      // Ghi doc `pending` để ràng id ↔ key ↔ người ký một cách nguyên tử, TRƯỚC khi
      // trả URL ra ngoài. Nhờ đó confirm không thể ghi metadata trỏ vào key của
      // người khác (key KHÔNG phải bí mật — nó nằm trong path của mọi URL đã ký),
      // confirm gọi lại lần hai không vỡ, và script dọn có danh sách pending có
      // thẩm quyền thay vì đoán theo tuổi file.
      await col.insertOne({ _id: newId, name, type, key, status: "pending", createdAt: Date.now() });
      res.status(200).json({ ok: true, id: newId, key, uploadUrl });
      return;
    }

    // ---- Bước 2: xác nhận đã lên R2, ghi metadata ----
    if (req.method === "POST" && action === "confirm") {
      const key = url.searchParams.get("key") || "";
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      if (!KEY_RE.test(key)) { res.status(400).json({ ok: false, error: "Key không hợp lệ" }); return; }

      const doc = await col.findOne({ _id: id });
      if (!doc || doc.key !== key) {
        res.status(400).json({ ok: false, error: "Phiên tải lên không hợp lệ" });
        return;
      }
      // Idempotent: retryUp ở client bọc lời gọi này, nên khi lần đầu thành công mà
      // response mất (cold start, Wi-Fi đổi sang 4G) thì lần thử lại phải trả 200 y hệt.
      // Không có nhánh này thì client thấy ok=false → save() không chạy → file 200MB
      // nằm trong R2 mà không dòng nào trỏ tới, còn người dùng bị báo là thất bại.
      if (doc.status === "ready") {
        res.status(200).json({ ok: true, file: fileOf(doc) });
        return;
      }
      if (doc.status !== "pending") {
        res.status(400).json({ ok: false, error: "Phiên tải lên không hợp lệ" });
        return;
      }

      // Ký RIÊNG cho HEAD — ký cho GET rồi gọi HEAD sẽ sai chữ ký.
      // Timeout 5s: confirm giờ có lời gọi ra ngoài trong một serverless invocation.
      // HEAD treo sẽ ăn hết budget và Vercel trả HTML lỗi, mà apiJson ở client biến
      // nó thành "máy chủ trả lỗi HTTP 504" — sau khi 200MB đã truyền xong.
      let head;
      try {
        head = await fetch(await signR2(key, "HEAD", 300), {
          method: "HEAD",
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        console.error("confirm: HEAD toi R2 that bai", e);
        res.status(503).json({ ok: false, error: "Kho lưu trữ không phản hồi, hãy thử lại" });
        return;
      }
      // Tách 404 và 403: báo "chưa thấy file" khi thật ra sai chữ ký sẽ dẫn debug
      // đi sai hướng cả buổi.
      if (head.status === 404) {
        res.status(400).json({ ok: false, error: "Chưa thấy file trên kho lưu trữ" });
        return;
      }
      if (head.status === 403) {
        console.error("confirm: R2 tra 403 — sai chu ky hoac sai quyen khoa API");
        res.status(500).json({ ok: false, error: "Lỗi chữ ký khi kiểm tra file" });
        return;
      }
      if (!head.ok) {
        console.error("confirm: R2 tra HTTP " + head.status);
        res.status(503).json({ ok: false, error: "Kho lưu trữ trả lỗi, hãy thử lại" });
        return;
      }

      // Lấy size từ HEAD chứ không tin client: vừa chính xác, vừa chặn ghi metadata
      // cho file chưa hề được tải lên.
      const size = Number(head.headers.get("content-length"));
      if (!Number.isFinite(size) || size <= 0) {
        res.status(400).json({ ok: false, error: "File trên kho lưu trữ rỗng" });
        return;
      }
      if (size > MAX_UPLOAD) {
        try { await fetch(await signR2(key, "DELETE", 300), { method: "DELETE", signal: AbortSignal.timeout(5000) }); }
        catch (e) { console.error("confirm: khong xoa duoc object qua lon", e); }
        await col.deleteOne({ _id: id, status: "pending" });
        res.status(413).json({ ok: false, error: "File quá lớn (giới hạn 200MB)" });
        return;
      }

      const confirmedAt = Date.now();
      const upd = await col.updateOne(
        { _id: id, key, status: "pending" },
        { $set: { status: "ready", size, confirmedAt } }
      );
      if (upd.matchedCount !== 1) {
        // Hai lời gọi confirm chạy song song: lời gọi kia vừa chuyển sang ready.
        const again = await col.findOne({ _id: id });
        if (again && again.key === key && again.status === "ready") {
          res.status(200).json({ ok: true, file: fileOf(again) });
          return;
        }
        res.status(400).json({ ok: false, error: "Phiên tải lên không hợp lệ" });
        return;
      }
      res.status(200).json({
        ok: true,
        file: fileOf({ _id: id, name: doc.name, type: doc.type, size }),
      });
      return;
    }

    // ---- Tải file xuống ----
    if (req.method === "GET") {
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      const doc = await col.findOne({ _id: id });
      if (!doc) { res.status(404).json({ ok: false, error: "Không tìm thấy file" }); return; }

      // ---- FILE MỚI: chuyển hướng thẳng sang R2 ----
      if (doc.key) {
        if (doc.status !== "ready") {
          // doc pending = phiên tải lên chưa xong, chưa phải một file
          res.status(404).json({ ok: false, error: "Không tìm thấy file" });
          return;
        }
        // no-store là BẮT BUỘC. Code file cũ bên dưới đặt max-age=31536000, immutable;
        // để header đó rơi vào nhánh này là nhét một credential 5 phút vào cache 1 năm:
        // 5 phút sau mọi lần bấm đều nhận AccessDenied từ R2, không xoá được nếu không
        // xoá dữ liệu site. Người dùng báo "file hỏng" trong khi file hoàn toàn nguyên vẹn.
        //
        // Tên file và MIME KHÔNG cần tham số response-* — chúng đã nằm sẵn trên object
        // (client gắn Content-Disposition + Content-Type lúc PUT).
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Location", await signR2(doc.key, "GET", 300));
        res.status(302).end();
        return;
      }

      // Chốt an toàn: doc không có `key`, cũng không có `data`/`chunks` thì docBuffer()
      // sẽ trả buffer rỗng mà không báo lỗi → người dùng nhận file 0 byte kèm cache
      // 1 năm. Thà hỏng ồn ào còn hơn hỏng im lặng. (Giữ nguyên từ giai đoạn 0 — đây
      // là thứ làm cho `vercel rollback` an toàn.)
      if (!doc.data && !Array.isArray(doc.chunks)) {
        res.setHeader("Cache-Control", "no-store");
        res.status(410).json({
          ok: false,
          error: "File này lưu ở kho mới, bản web đang chạy chưa đọc được. Hãy tải lại trang."
        });
        return;
      }

      // ---- FILE CŨ: đọc thẳng từ MongoDB, giữ nguyên như trước ----
      // file chia mảnh + ?part=i -> trả riêng mảnh đó (client tự ghép)
      const partRaw = url.searchParams.get("part");
      if (Array.isArray(doc.chunks) && partRaw != null) {
        const pi = Number(partRaw);
        if (!(pi >= 0 && pi < doc.chunks.length)) { res.status(400).json({ ok: false, error: "part không hợp lệ" }); return; }
        const cd = await col.findOne({ _id: doc.chunks[pi] });
        if (!cd) { res.status(404).json({ ok: false, error: "Mất mảnh file" }); return; }
        const cb = docBuffer(cd);
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", cb.length);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.status(200).send(cb);
        return;
      }

      // file chia mảnh, tải cả cục (chỉ dùng được khi tổng < giới hạn response;
      // giao diện web luôn tải theo ?part nên nhánh này chỉ là dự phòng)
      let buf;
      if (Array.isArray(doc.chunks)) {
        const parts = [];
        for (const cid of doc.chunks) {
          const cd = await col.findOne({ _id: cid });
          if (!cd) { res.status(404).json({ ok: false, error: "Mất mảnh file" }); return; }
          parts.push(docBuffer(cd));
        }
        buf = Buffer.concat(parts);
      } else {
        buf = docBuffer(doc);
      }
      const name = doc.name || "file";
      const asciiName = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
      res.setHeader("Content-Type", doc.type || "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.setHeader("Content-Disposition",
        "attachment; filename=\"" + asciiName + "\"; filename*=UTF-8''" + encodeURIComponent(name));
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.status(200).send(buf);
      return;
    }

    // ---- Xoá file (object R2 hoặc mọi mảnh trong MongoDB) ----
    if (req.method === "DELETE") {
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      const doc = await col.findOne({ _id: id }, { projection: { key: 1, chunks: 1 } });
      // Giữ guard này: removeFile ở client gọi DELETE kiểu bắn-rồi-quên, nên xoá
      // cùng một file hai lần là chuyện bình thường (hai tab, hoặc hai người trên
      // một dòng đang đồng bộ). Bỏ đi thì lần thứ hai ném lỗi → 500 thay vì 200 êm ả.
      if (!doc) { res.status(200).json({ ok: true }); return; }

      if (doc.key) {
        // Xoá object hỏng thì VẪN xoá metadata và trả ok — metadata trỏ vào hư không
        // tệ hơn một file mồ côi. Ghi log để còn dấu vết cho script dọn.
        try { await fetch(await signR2(doc.key, "DELETE", 300), { method: "DELETE", signal: AbortSignal.timeout(5000) }); }
        catch (e) { console.error("DELETE: khong xoa duoc object R2 " + doc.key, e); }
      }
      if (Array.isArray(doc.chunks) && doc.chunks.length) {
        await col.deleteMany({ _id: { $in: doc.chunks } });
      }
      await col.deleteOne({ _id: id });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: "Method Not Allowed" });
  } catch (error) {
    // KHÔNG trả nguyên error.message về client. Chuỗi đó có thể chứa cả URL đã ký
    // (kèm X-Amz-Credential và chữ ký còn hiệu lực), hoặc E11000 kèm tên database
    // và tên index — một kênh dò _id có sẵn.
    console.error(error);
    res.status(500).json({ ok: false, error: "Lỗi máy chủ" });
  }
};

function fileOf(doc) {
  return {
    id: doc._id,
    name: doc.name || "file",
    size: doc.size || 0,
    type: doc.type || "application/octet-stream",
    url: "api/files?id=" + doc._id,
  };
}
