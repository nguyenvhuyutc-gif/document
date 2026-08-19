// ============================================================
//  API lưu file đính kèm vào MongoDB (collection riêng: bim_files)
//
//  File nhỏ (≤ ~3.5MB) — 1 request, 1 document:
//   POST /api/files?name=<tên>&type=<mime>   body = nội dung file (nhị phân)
//        -> lưu file, trả { ok, file: { id, name, size, type, url } }
//
//  File lớn (tối đa 50MB) — chia mảnh vì Vercel giới hạn body ~4.5MB
//  và MongoDB giới hạn 16MB/document:
//   POST /api/files?action=chunk              body = 1 mảnh (≤4.4MB)
//        -> { ok, chunkId }
//   POST /api/files?action=finish&name=&type=&chunks=id1,id2,...
//        -> ghép meta, trả { ok, file: { id, name, size, type, url, chunks: n } }
//   GET  /api/files?id=<id>&part=<i>          -> tải mảnh thứ i (client tự ghép)
//
//   GET  /api/files?id=<id>                   -> tải file xuống (đính kèm)
//   DELETE /api/files?id=<id>                 -> xoá file (kèm mọi mảnh)
// ============================================================
const { MongoClient, Binary } = require("mongodb");
const crypto = require("crypto");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "bim";
const filesCollection = process.env.MONGODB_FILES_COLLECTION || "bim_files";

const MAX_BYTES = 4.4 * 1024 * 1024;        // giới hạn 1 request (Vercel ~4.5MB)
const MAX_FILE  = 50 * 1024 * 1024;         // giới hạn 1 file sau khi ghép mảnh

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

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(req.body)) return resolve(req.body);
    if (req.body && req.body.type === "Buffer" && Array.isArray(req.body.data)) {
      return resolve(Buffer.from(req.body.data));
    }
    const chunks = [];
    let size = 0, tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES + 1024) { tooBig = true; req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => tooBig ? reject(new Error("TOO_BIG")) : resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function docBuffer(doc) {
  return doc.data && doc.data.buffer ? Buffer.from(doc.data.buffer) : Buffer.from(doc.data || "");
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    const action = url.searchParams.get("action");
    const { db } = await connectMongo();
    const col = db.collection(filesCollection);

    // ---- Tải file xuống ----
    if (req.method === "GET") {
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      const doc = await col.findOne({ _id: id });
      if (!doc) { res.status(404).json({ ok: false, error: "Không tìm thấy file" }); return; }

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

    // ---- Tải 1 mảnh lên ----
    if (req.method === "POST" && action === "chunk") {
      let buf;
      try { buf = await readRawBody(req); }
      catch (e) {
        if (String(e.message) === "TOO_BIG") { res.status(413).json({ ok: false, error: "Mảnh quá lớn" }); return; }
        throw e;
      }
      if (!buf || !buf.length) { res.status(400).json({ ok: false, error: "Mảnh rỗng" }); return; }
      const chunkId = "c" + crypto.randomBytes(12).toString("hex");
      await col.insertOne({ _id: chunkId, kind: "chunk", size: buf.length, data: new Binary(buf), createdAt: Date.now() });
      res.status(200).json({ ok: true, chunkId: chunkId });
      return;
    }

    // ---- Ghép các mảnh thành file ----
    if (req.method === "POST" && action === "finish") {
      const name = url.searchParams.get("name") || "file";
      const type = url.searchParams.get("type") || "application/octet-stream";
      const ids = String(url.searchParams.get("chunks") || "").split(",").filter(Boolean);
      if (!ids.length) { res.status(400).json({ ok: false, error: "Thiếu danh sách mảnh" }); return; }
      const docs = await col.find({ _id: { $in: ids } }).project({ size: 1 }).toArray();
      if (docs.length !== ids.length) { res.status(400).json({ ok: false, error: "Mất mảnh file — hãy tải lại" }); return; }
      const total = docs.reduce((s, d) => s + (d.size || 0), 0);
      if (total > MAX_FILE) {
        await col.deleteMany({ _id: { $in: ids } });
        res.status(413).json({ ok: false, error: "File quá lớn (giới hạn 50MB)" });
        return;
      }
      const newId = crypto.randomBytes(12).toString("hex");
      await col.insertOne({ _id: newId, name: name, type: type, size: total, chunks: ids, createdAt: Date.now() });
      res.status(200).json({ ok: true, file: { id: newId, name: name, size: total, type: type, url: "api/files?id=" + newId, chunks: ids.length } });
      return;
    }

    // ---- Tải file lên (1 request, file nhỏ) ----
    if (req.method === "POST") {
      const name = url.searchParams.get("name") || "file";
      const type = url.searchParams.get("type") || "application/octet-stream";
      let buf;
      try { buf = await readRawBody(req); }
      catch (e) {
        if (String(e.message) === "TOO_BIG") { res.status(413).json({ ok: false, error: "File quá lớn cho 1 request — cần tải theo mảnh" }); return; }
        throw e;
      }
      if (!buf || !buf.length) { res.status(400).json({ ok: false, error: "File rỗng" }); return; }
      if (buf.length > MAX_BYTES) { res.status(413).json({ ok: false, error: "File quá lớn cho 1 request — cần tải theo mảnh" }); return; }

      const newId = crypto.randomBytes(12).toString("hex");
      await col.insertOne({
        _id: newId,
        name: name,
        type: type,
        size: buf.length,
        data: new Binary(buf),
        createdAt: Date.now()
      });
      res.status(200).json({ ok: true, file: { id: newId, name: name, size: buf.length, type: type, url: "api/files?id=" + newId } });
      return;
    }

    // ---- Xoá file (kèm mọi mảnh) ----
    if (req.method === "DELETE") {
      if (!id) { res.status(400).json({ ok: false, error: "Thiếu id" }); return; }
      const doc = await col.findOne({ _id: id }, { projection: { chunks: 1 } });
      if (doc && Array.isArray(doc.chunks) && doc.chunks.length) {
        await col.deleteMany({ _id: { $in: doc.chunks } });
      }
      await col.deleteOne({ _id: id });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: "Method Not Allowed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: String(error && error.message || error) });
  }
};
