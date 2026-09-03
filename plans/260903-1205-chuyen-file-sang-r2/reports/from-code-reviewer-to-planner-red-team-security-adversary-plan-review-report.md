# Red Team Review — Security Adversary — Plan: "Chuyển file đính kèm từ MongoDB sang Cloudflare R2"

Reviewer role: hostile Security Adversary (attacker mindset).
Target: `plans/260903-1205-chuyen-file-sang-r2/` (plan.md + phases 01–04).
All findings backed by grep/glob evidence or live probes against the two deployments.

---

## Finding 1: `bim-wheat.vercel.app` is a live, unauthenticated DELETE endpoint against the same `bim_files` collection — the plan rates this "Thấp"

- **Severity:** Critical
- **Location:** plan.md, "Rủi ro toàn cục" table, row `Site cũ bim-wheat.vercel.app chạy code cũ, chung MongoDB | Thấp | Nó chỉ đọc được file cũ, không thấy file mới`; also phase-04, "Rủi ro" table, same row.
- **Flaw:** The plan asserts the old deployment can only *read* old files. That is false in both directions. The old site runs pre-auth code and accepts `DELETE /api/files?id=<any id>` with **no key at all**, against the exact collection the plan is about to make the sole source of truth for R2-backed files.
- **Failure scenario:**
  1. Anyone on the internet reads `GET https://bim-wheat.vercel.app/api/data?plan=data` (unauthenticated) and harvests every `f.id` in the table.
  2. They send `DELETE https://bim-wheat.vercel.app/api/files?id=<id>` for each one. Old code hits `col.deleteOne({ _id: id })` and returns `{ok:true}`.
  3. Today that only loses a MongoDB blob. **After this plan**, the deleted document was the *only* record of `key` — the R2 object survives but is now unreachable by anything, and unrecoverable because nobody knows the 12-hex key.
  4. Then the plan's own Phase 4 cleanup script (`scripts/don-file-mo-coi.mjs`, step 3: "Object có trong R2 mà không có trong MongoDB VÀ cũ hơn 7 ngày") classifies those objects as orphans and **deletes them permanently**. The attack completes itself, on a schedule the victim runs by hand.

  Net effect: the entire `ADMIN_KEY`-gated delete path designed in phase-02 ("`DELETE ?id=` — cần `ADMIN_KEY`") is bypassable by an anonymous request to a hostname the user cannot deploy to.
- **Evidence:**
  - Live probe (this review): `DELETE https://bim-ruddy.vercel.app/api/files?id=zzz-probe` → `HTTP 401 {"ok":false,"needKey":true,...}`. Same request to `https://bim-wheat.vercel.app/api/files?id=zzz-probe-2` → `HTTP 200 {"ok":true}`.
  - Live probe: `GET https://bim-wheat.vercel.app/api/data?whoami=1` returns full plan data, not `{role, protected}` → old site predates the auth commit entirely. Compare `api/data.js:78-79`.
  - Old delete path that will run: `api/files.js:223-232` (`col.deleteOne({ _id: id })`, returns `{ok:true}` unconditionally).
  - Shared database confirmed by `CLAUDE.md:8-10` and `docs/phan-quyen-mat-khau.md` troubleshooting row "Site cũ `bim-wheat.vercel.app` vẫn sửa được dữ liệu … dùng chung MongoDB".
  - Live probe: `GET https://bim-wheat.vercel.app/api/data?list=1` → returns all three plan ids unauthenticated.
- **Suggested fix:** This is a hard blocker and must be resolved in Phase 1, not "chấp nhận". Either (a) rotate the MongoDB Atlas password and give only the `bim` project the new one — `docs/phan-quyen-mat-khau.md` already names this as the only real fix — or (b) write R2 metadata to a **new collection** (`bim_files_r2`) that the old code never touches, and make the cleanup script require a positive MongoDB match plus a tombstone log rather than inferring orphanhood from absence. Option (b) alone still leaves the old site able to delete the table rows that reference the files.

---

## Finding 2: The old deployment will serve R2-backed files as HTTP 200 with zero bytes, and keeps minting `Binary` documents — acceptance criteria 3 and 6 are unachievable as written

- **Severity:** High
- **Location:** plan.md, "Tiêu chí nghiệm thu toàn dự án" items 3 and 6; phase-04 "Kiểm tra MongoDB sau khi test".
- **Flaw:** Two distinct breakages the plan does not model.

  **(a) Silent 0-byte downloads.** The old client renders `a.href = f.url` where `f.url` is the *relative* string `"api/files?id=X"` (`api/files.js:182`, `api/files.js:208`). On `bim-wheat` that resolves to the old site's own function. For an R2 document there is no `data` and no `chunks`, so `docBuffer(doc)` returns `Buffer.from(doc.data || "")` — an **empty buffer** — and the handler still sends `200` with the correct filename and `Content-Length: 0`. Users on the old site get a file that appears to download successfully and is empty. No error surfaces anywhere.

  **(b) New `Binary` docs keep appearing.** Any editor still using `bim-wheat` uploads through `action=chunk`/`action=finish`, which writes `data: new Binary(buf)` into the shared `bim_files`. Acceptance criterion 6 ("Không còn document `Binary` nào **được tạo mới** trong `bim_files`") and the Phase 4 verification query `db.bim_files.find({data:{$exists:true}, createdAt:{$gt:...}}).count() === 0` will be non-deterministically red, and the 512MB M0 ceiling — the stated motivation for the whole project — keeps filling.
- **Evidence:**
  - `api/files.js:76-78` — `docBuffer` returns `Buffer.from(doc.data || "")` when `doc.data` is absent.
  - `api/files.js:137-147` — the `else` branch calls `docBuffer(doc)` then `res.status(200).send(buf)` with `Content-Length: buf.length`; no existence check on `doc.data`.
  - `api/files.js:152-164` (`action=chunk`, writes `new Binary`), `api/files.js:167-184` (`action=finish`), `api/files.js:199-209` (small-file path, writes `new Binary`).
  - Live probe confirms the old code is deployed and unlocked (see Finding 1 evidence).
- **Suggested fix:** In `api/files.js`, make the legacy read path fail loudly: `if (!doc.data && !Array.isArray(doc.chunks)) return 404`. That does not help `bim-wheat` (it runs its own copy), so additionally reword criteria 3 and 6 to scope them to `bim-ruddy` only, and add an explicit written acceptance that the old site produces corrupt downloads until the MongoDB credential is rotated.

---

## Finding 3: The presigned PUT signs nothing about the body — `size` is advisory, the URL is replayable for 15 minutes, and there is no cap on how many can be minted

- **Severity:** High
- **Location:** phase-02, "`POST ?action=sign-upload&name=&type=&size=`" and the `signR2()` helper; phase-01 §1.2.
- **Flaw:** `signR2(key, "PUT", 900)` signs only method + URL + query with `signQuery: true`. Phase 2 deliberately signs **no headers** ("KHÔNG ký `Content-Type`"), which also means no `content-length`. SigV4 query-signing therefore places **zero constraint on the request body**. The `0 < size ≤ 200MB` check happens on a client-supplied query parameter and controls nothing.
- **Failure scenario:**
  1. Any holder of the shared `EDIT_KEY` — a single plaintext password kept in every editor's `localStorage` (`bang-hang-muc.html:966-974`), shared verbatim per `docs/phan-quyen-mat-khau.md` — calls `sign-upload&size=1` in a loop.
  2. Each response is a 15-minute, unlimited-size, **replayable** PUT capability. They stream terabytes into the bucket, or PUT the same URL repeatedly to overwrite.
  3. They never call `confirm`, so the plan's `HEAD`-based size check at confirm time never runs. The objects are invisible to the app and are only reachable by the manual cleanup script that runs "khi rảnh" with a 7-day grace window.
  4. Billing is Cloudflare's, uncapped, with no alert designed anywhere in the plan.

  The same defect hits honest users: phase-03's `uploadDirect()` sample calls `sign-upload` and `confirm` with bare `fetch(...)`, **not** `retryUp` — contradicting phase-03's own "Giữ nguyên tuyệt đối … `retryUp` (vẫn dùng cho `sign-upload` và `confirm`)". One transient blip on `confirm` after a successful 200MB PUT loses the upload *and* leaves a 200MB orphan.
- **Evidence:**
  - phase-02 `signR2()` — `r2.sign(u.toString(), { method, aws: { signQuery: true } })`, no `headers`, no `content-length`.
  - phase-02 "KHÔNG ký `Content-Type`" section — establishes the no-signed-headers stance.
  - phase-03 `uploadDirect()` code block — `return fetch("api/files?action=sign-upload"…)` and `return fetch("api/files?action=confirm"…)`, both un-wrapped; contrast `bang-hang-muc.html:1523-1527` (`retryUp`) and its existing use at `bang-hang-muc.html:1543,1554`.
  - Shared-password model: `bang-hang-muc.html:966` (`AUTH_KEY_STORE = "vci_bhm_edit_key"`), `api/files.js:35-43` (`getRole`, single env-var compare).
  - phase-01 §1.2 grants the token "Object Read & Write" on the whole bucket with no size or rate policy.
- **Suggested fix:** Sign `content-length` (the client already knows `proc.blob.size` exactly, so the fragility argument that applies to `Content-Type` does not apply here) — `aws4fetch` supports signed headers. Failing that, use an S3 POST policy with `content-length-range`. Separately, wrap `sign-upload`/`confirm` in `retryUp` as phase-03 claims it does, and set a Cloudflare billing alert in Phase 1.

---

## Finding 4: `confirm` validates the key's *shape*, not its *provenance* — plus a client-controlled `_id` and a reflected MongoDB error

- **Severity:** High
- **Location:** phase-02, "`POST ?action=confirm&id=&key=&name=&type=`".
- **Flaw:** The regex `^bim/\d{4}-\d{2}/[0-9a-f]{12}(\.[a-z0-9]{1,8})?$` is correct at what it does (JS `$` does not admit a trailing newline, and `new URL()` normalisation of `../` is unreachable through it). But it only proves the key *looks* like one this server could have issued — nothing records which keys **were** issued, to whom, or against which `id`. Two consequences the plan claims are covered but are not:

  **(a) Key aliasing.** Object keys are not secret: they appear verbatim in the path of every presigned GET, which is handed out to **anonymous** requesters via the 302 (Finding 5), and therefore land in browser history, corporate proxies, and referrer chains. An `EDIT_KEY` holder replays a harvested key into `confirm` with a fresh `id` and their own `name`/`type`. Now two documents reference one object, with **no reference counting anywhere in the plan**. When an admin later deletes the decoy, phase-02's DELETE issues the R2 delete and the legitimate row silently becomes a 302 to a dead object — and phase-02 explicitly swallows R2 delete failures ("Xóa object R2 hỏng thì **vẫn xóa metadata** và trả `ok`"), so there is no signal either way.

  **(b) Client-controlled primary key.** `insertOne({_id: id, …})` uses the `id` the client sends at confirm time, not the one issued at `sign-upload`. Feeding an existing `_id` (another file's id, or a legacy chunk id of the form `c` + 24 hex from `api/files.js:160`) raises `E11000` and falls into the catch block that returns the **raw driver message** to the client — an existence oracle over `_id` values plus disclosure of `bim.bim_files` and index names.
- **Evidence:**
  - `api/files.js:235-238` — `catch (error) { console.error(error); res.status(500).json({ ok:false, error: String(error && error.message || error) }); }` — reflects the driver message verbatim. Phase-02's "Gỡ bỏ" and "Giữ lại" lists never touch this handler.
  - `api/files.js:160` — chunk ids are `"c" + crypto.randomBytes(12).toString("hex")`, i.e. guessable-format `_id`s already in the collection.
  - phase-02 `confirm` pseudo-code: `insertOne { _id: id, name, type, size: <size THẬT từ HEAD>, key, createdAt }` — `id` and `key` both arrive from the request.
  - phase-02 DELETE pseudo-code plus its "Xóa object R2 hỏng thì vẫn xóa metadata" note — no reference count, no failure surface.
  - Keys are exposed anonymously: `GET /api/data?plan=…` is unauthenticated (`api/data.js:81-90` gates only POST/DELETE) and returns every `f.url`; live probe returned `"url":"api/files?id=3d14b4ba1e6ace9e7b154e5f"`.
- **Suggested fix:** Write a short-lived pending record at `sign-upload` (`{_id: id, key, status:"pending", createdAt}`) and have `confirm` do `updateOne({_id: id, key, status:"pending"}, {$set:{status:"ready", …}})`. That binds id↔key↔issuer in one atomic step, kills aliasing and the duplicate-`_id` oracle, and gives the cleanup script an authoritative pending list instead of guessing by age. Also replace the generic catch with a fixed message and log the detail server-side only.

---

## Finding 5: The 302 publishes `R2_ACCESS_KEY_ID` and `R2_ACCOUNT_ID` to every anonymous requester — acceptance criterion 7 and test #11 are contradicted by the design itself

- **Severity:** High
- **Location:** plan.md, "Tiêu chí nghiệm thu toàn dự án" item 7 ("Khóa R2 không xuất hiện trong bất kỳ response nào gửi về client"); plan.md "Rủi ro toàn cục" row "Rò khóa R2 ra client … client chỉ thấy URL hết hạn 15 phút"; phase-04 test matrix items 11 and 12.
- **Flaw:** SigV4 query-string signing (`signQuery: true`) *requires* `X-Amz-Credential=<AccessKeyId>/<date>/auto/s3/aws4_request` in the URL, and the endpoint host is `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. Both are listed in phase-01 §1.4 as environment secrets to be set on Vercel. Every unauthenticated `GET /api/files?id=…` will therefore return a `Location` header containing the R2 Access Key ID and the Cloudflare Account ID in cleartext. The plan states the opposite as a pass criterion.

  Test #12 ("copy presigned URL, wait 5 minutes, reopen → rejected") measures the wrong secret. The expiring URL is not the capability; the **`id` is**, it never expires, and `GET /api/data` hands out every one of them to anyone. `GET /api/files?id=…` becomes an unauthenticated, unrate-limited **signing oracle**: refresh it and you get a new 5-minute URL forever.
- **Evidence:**
  - phase-02 `signR2()` sets `aws: { signQuery: true }` and builds `R2_BASE = https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}` — the account id is the hostname.
  - phase-01 §1.4 table lists `R2_ACCOUNT_ID` and `R2_ACCESS_KEY_ID` as environment variables alongside `R2_SECRET_ACCESS_KEY`.
  - `api/data.js:81-90` — auth gate covers only `POST`/`DELETE`; `GET ?plan=` and `GET ?list=1` are open. Live probe: `GET https://bim-wheat.vercel.app/api/data?plan=data` returned the full table including file ids, unauthenticated.
  - `vercel.json:9` — `Access-Control-Allow-Origin: *` on `/api/(.*)`, so any third-party page can drive the oracle from the browser.
  - Live probe: `curl -I https://bim-ruddy.vercel.app/api/files?id=…` → `Access-Control-Allow-Origin: *` present on the files endpoint today.
- **Suggested fix:** Restate criterion 7 accurately — "`R2_SECRET_ACCESS_KEY` must never leave the function; `R2_ACCESS_KEY_ID` and `R2_ACCOUNT_ID` are published by design in every presigned URL" — and rewrite test #11 to grep the `Location` **header**, not just response bodies, for the *secret*. Then decide deliberately: either accept the exposure (and treat the access key id as public, rotating on a schedule), or front R2 with a Cloudflare Worker / custom domain so the account id never appears. Replace test #12 with the real question: "does knowing an `id` grant permanent download?" — the answer today is yes.

---

## Finding 6: The plan never specifies caching on the 302, and the handler it says to preserve stamps `max-age=31536000, immutable` on that exact path

- **Severity:** High
- **Location:** phase-02, "`GET ?id=<id>` — tự do, không cần mật khẩu" — the branch is specified as `→ 302 Location: url` with no header discussion; phase-02 "Giữ lại" list ("nhánh GET `data`/`chunks`/`?part=`").
- **Flaw:** The current GET handler sets `Cache-Control: public, max-age=31536000, immutable` on the download response. The plan tells the implementer to add an `if (doc.key)` branch at the top of that same handler and leave the rest alone, but never says the redirect must be `no-store`. The obvious mistake — copying the existing header, or letting a shared cache treat the redirect as cacheable — bakes a **5-minute credential into a 1-year cache entry**.
- **Failure scenario:** User A downloads a 200MB Revit model. The browser (and any intermediary/Vercel edge cache, since `Access-Control-Allow-Origin: *` and there is no `Vary` on anything user-specific) stores the 302 for `api/files?id=X` for a year. Five minutes later that user, and anyone served from the same cache entry, gets `AccessDenied` from R2 on every subsequent click, with no way to bust it short of a hard reload. Support reports it as "the file is broken"; the file is fine. Simultaneously, a signed URL that the plan justifies as safe *because it expires* is now persisted in a shared cache long past its expiry.
- **Evidence:**
  - `api/files.js:146` — `res.setHeader("Cache-Control", "public, max-age=31536000, immutable");` on the whole-file GET path.
  - `api/files.js:121` — same header on the `?part=` path.
  - phase-02 "Rủi ro" row: "Đọc file cũ **chỉ thêm điều kiện `if (doc.key)` ở đầu**, không sửa code cũ bên dưới" — explicitly instructs a minimal edit that leaves the caching code in place with no mention of the new branch's headers.
  - phase-02 acceptance checklist has no cache-header item; phase-04's 13-item matrix has none either.
- **Suggested fix:** Add to phase-02: the `doc.key` branch must set `Cache-Control: private, no-store` and `Pragma: no-cache` **before** `res.redirect(302, url)`, and add an acceptance line `curl -sI 'api/files?id=<new>' | grep -i cache-control` → `no-store`.

---

## Finding 7: Phase 4 writes R2 key-rotation instructions into a directory that is publicly served on production — proven, not theoretical

- **Severity:** High
- **Location:** phase-04, "Cập nhật tài liệu" (`docs/luu-file-r2.md`: "sơ đồ luồng, 4 biến môi trường, **cách xoay khóa R2**, cách chạy script dọn file mồ côi"; `CLAUDE.md` → "Thêm 4 biến R2 vào danh sách biến môi trường production"); phase-01 §1.5 (`scratch/test-r2.mjs`); phase-04 (`scripts/don-file-mo-coi.mjs`).
- **Flaw:** `.vercelignore` enumerates exactly what is withheld from the deployment, and `docs/`, `plans/`, `scripts/`, `scratch/` and root `*.md` are not among them. Markdown under `docs/` and at the repo root is **live on production right now**. `vercel deploy` uploads the working directory, not git HEAD, so phase-01's "Tạm (không commit): `scratch/test-r2.mjs`" is not protected by being uncommitted — and it is in neither `.gitignore` nor `.vercelignore` either.
- **Failure scenario:** After Phase 4, `https://bim-ruddy.vercel.app/docs/luu-file-r2.md` serves the R2 architecture, bucket name, all four environment variable names, and the key-rotation runbook to anyone. `https://bim-ruddy.vercel.app/plans/260903-1205-chuyen-file-sang-r2/phase-01-ha-tang-r2.md` serves the whole infrastructure design. If the R2 test script is still on disk at deploy time it ships too. Individually low-value; together they are a complete map for anyone who later obtains a partial credential — and Finding 5 already publishes the access key id and account id.
- **Evidence (live probes, this review):**
  - `GET https://bim-ruddy.vercel.app/docs/phan-quyen-mat-khau.md` → **HTTP 200**, body begins `# Phân quyền bằng mật khẩu — Bảng theo dõi hạng mục`.
  - `GET https://bim-ruddy.vercel.app/CLAUDE.md` → **HTTP 200**. `HUONG-DAN-DEPLOY.md` → **200**. `SO-TAY-CAU-LENH.md` → **200**.
  - `HUONG-DAN-DEPLOY.md:52` is therefore already public: `MONGODB_URI = mongodb+srv://ngothuytq98_db_user:<mật_khẩu>@cluster0.lafx8yo.mongodb.net/…` — real database username and cluster host. Same string at `.env.example:2`.
  - `docs/brainstorm-chuyen-file-sang-r2.md` → 404 only because it postdates the last deploy; `plans/` likewise. Both are in the working tree and will ship on the next `npm run deploy`.
  - `.vercelignore` contents: `.env`, `.env.*`, `!.env.example`, `serve.cjs`, `start-server.bat`, `data.json`, `node_modules`, `.DS_Store`, `npm-debug.log*`, `.claude`, `data-files` — no `docs`, `plans`, `scripts`, `scratch`, or `*.md`.
  - `grep -n "scratch\|scripts" .gitignore .vercelignore` → no match in either file.
- **Suggested fix:** Add to Phase 1 (before anything is written): append `docs/`, `plans/`, `scripts/`, `scratch/`, `*.md`, `!README.md` to `.vercelignore`, and `scratch/` to `.gitignore`. Add an acceptance line to phase-04: `curl -o /dev/null -w '%{http_code}' https://bim-ruddy.vercel.app/docs/luu-file-r2.md` → `404`. Separately, scrub the real Atlas username/host from `HUONG-DAN-DEPLOY.md:52` and `.env.example:2`.

---

## Finding 8: Phase 1.3 grants `http://localhost:3000` standing write access to the bucket — and 3000 is not even this project's local port

- **Severity:** Medium
- **Location:** phase-01 §1.3, CORS policy `AllowedOrigins: ["https://bim-ruddy.vercel.app", "http://localhost:3000"]`, `AllowedHeaders: ["*"]`.
- **Flaw:** Two problems in one block. (a) `http://localhost:3000` is a fact-check failure: this project's local server listens on **8787**, and the plan's own scope statement says the LAN mode is out of scope and unused — so the origin is not merely wrong, it is unnecessary. (b) It is a permanent entry in a bucket policy that holds 200MB CAD/Revit models, granting browser `PUT`/`GET` from anything a victim loads on `localhost:3000` — a very common dev-server port, and one that unrelated local software binds routinely. Combined with Finding 3 (an unbounded, replayable presigned PUT) and Finding 5 (the 302 oracle is `Access-Control-Allow-Origin: *`), a page served from any process on the victim's port 3000 is a viable driver for both.
- **Evidence:**
  - `serve.cjs:17` — `const port = Number(process.env.PORT) || 8787;` and `serve.cjs:348` references the same port. `CLAUDE.md` command table: "`npm start` | Chạy server LAN local (cổng 8787)".
  - plan.md "Phạm vi" → "Ngoài phạm vi: `serve.cjs` / chế độ LAN (không còn dùng)".
  - `package.json` scripts contain no dev server on 3000; there is no build step (`vercel-build` is `echo`).
  - `vercel.json:9-11` — `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Headers: Content-Type, x-edit-key`, confirmed live in the probe headers.
- **Suggested fix:** Drop `http://localhost:3000`. If local testing against R2 is genuinely needed, add `http://localhost:8787` for the duration and remove it afterwards, and note the removal in phase-04's checklist. Narrow `AllowedHeaders` to the headers actually sent (with the plan's design, that is effectively none for the PUT).

---

## Finding 9: `aws4fetch` is admitted into the process that already holds every secret, on a bundle-size argument alone

- **Severity:** Medium
- **Location:** phase-01 §1.6 ("Chọn `aws4fetch` (~6KB) thay vì `@aws-sdk/client-s3` (~10MB) để không làm chậm cold start"); phase-02 ("`aws4fetch@1.0.20` có export `require`").
- **Flaw:** The only stated selection criterion is size. `api/files.js` runs with `MONGODB_URI`, `EDIT_KEY`, `ADMIN_KEY`, and now `R2_SECRET_ACCESS_KEY` all live in `process.env` of the same process — a compromised release of this dependency exfiltrates the entire security posture of the application in one step, and the plan's only exfil check (phase-04 test #11) inspects the browser's Network tab, which cannot see a server-to-server callout. The install command is `npm install aws4fetch` (unpinned caret), phase-02 asserts behaviour specific to `1.0.20`, no `--ignore-scripts` is used, and no lockfile/`npm ci` discipline is stated even though a `package-lock.json` is tracked.
- **Evidence:**
  - phase-01 §1.6 — the entire rationale is the size comparison; no maintainer, provenance, or install-script discussion.
  - `api/files.js:22-24` (`MONGODB_URI`, `MONGODB_DB`, `MONGODB_FILES_COLLECTION`) and `api/files.js:36-37` (`ADMIN_KEY`, `EDIT_KEY`) — all in the same `process.env` the new dependency will share.
  - `package.json` `dependencies` currently contains exactly one entry (`"mongodb": "^5.8.0"`) — caret range, so `npm install aws4fetch` will follow the same unpinned convention.
  - Verified independently: `npm view aws4fetch` → version `1.0.20`, `exports["."]["require"] → ./dist/aws4fetch.cjs.js`. The CommonJS claim in phase-02 is correct; the supply-chain reasoning around it is what is missing.
- **Suggested fix:** Pin exactly (`"aws4fetch": "1.0.20"`, no caret), install with `--ignore-scripts`, commit the updated `package-lock.json`, and record the resolved integrity hash in `docs/luu-file-r2.md` (which per Finding 7 must not be deployed). Add a Phase 4 check that the R2 secret is read in exactly one place: `grep -rn "R2_SECRET_ACCESS_KEY" api/` → one hit.

---

### Verification Results

- **Tier:** Standard (Fact Checker + Contract Verifier, both applied)
- **Claims checked:** 34
- **VERIFIED:** 28
- **FAILED:** 6
- **UNVERIFIED:** 0

**Fact Checker — verified samples (file:line)**

Phase 1: `.env.example` exists (4 lines, `MONGODB_URI`/`MONGODB_DB`/`MONGODB_COLLECTION`) · `.gitignore:14-16` has `.env`, `.env*`, `!.env.example` · `package.json` has `vercel:env` = `vercel env pull .env` · `aws4fetch` is not currently a dependency (`package.json` deps = `mongodb` only) · `package.json` `engines.node = "22.x"`.

Phase 2: `safeEqual` `api/files.js:30`, `getRole` `api/files.js:35` · three-copy claim confirmed: `api/data.js:24,29`, `api/files.js:30,35`, `serve.cjs:37,42` · `docBuffer` `api/files.js:76` · `action=chunk` `api/files.js:152`, `action=finish` `api/files.js:167`, `DELETE ?chunks=` `api/files.js:213` · `readRawBody` `api/files.js:58` · `MAX_BYTES = 4.4MB` `api/files.js:26` · `Binary` imported `api/files.js:19` · `asciiName` + `filename*=UTF-8''` `api/files.js:141,144-145` · `aws4fetch@1.0.20` exposes a `require` condition (`npm view` → `exports["."]["require"].default = ./dist/aws4fetch.cjs.js`).

Phase 3: `a.href = f.url || f.dataUrl || "#"` `bang-hang-muc.html:1386` · `data-chunks` `bang-hang-muc.html:1389` · `downloadChunked(ff)` `bang-hang-muc.html:2297` · `dropChunks` `:1531` · `uploadChunked` `:1536` · `CHUNK_SIZE` `:1298` · `.files-cell.uploading` CSS at `:377-379` (exact match to the plan's quoted block) · `classList.add("uploading")` `:1595` · `--accent-weak` defined at `:66` and `:74` (also `:28`, `:53`) · `--accent-soft` does not exist (`grep -c` → 0) · `maybeCompress` `:1323`, `apiJson` `:1515`, `authHeaders` `:970`.

Phase 4: `.claude/skills/deploy-bim/SKILL.md` exists · `README.md` exists · the `CLAUDE.md` line "3 bản giống nhau — sửa một chỗ thì sửa cả ba" exists and is accurate today.

**FAILED claims**

1. **phase-01 §1.3** — CORS origin `http://localhost:3000`. This project's local server is port **8787** (`serve.cjs:17`; `CLAUDE.md` command table). No component of this repo serves on 3000. → Finding 8.
2. **phase-01 §1.5** — "`scratch/test-r2.mjs` (không commit)" is presented as safe by virtue of not being committed. `grep -n "scratch\|scripts" .gitignore .vercelignore` → no match in either file, and `vercel deploy` uploads the working directory, not git HEAD. → Finding 7.
3. **plan.md acceptance criterion 7** — "Khóa R2 không xuất hiện trong bất kỳ response nào gửi về client". SigV4 query signing (`signQuery: true`, phase-02 `signR2`) places `R2_ACCESS_KEY_ID` in `X-Amz-Credential` and `R2_ACCOUNT_ID` in the hostname of the 302 `Location`, returned to unauthenticated clients. → Finding 5.
4. **phase-03 "Giữ nguyên tuyệt đối"** — "`retryUp` (vẫn dùng cho `sign-upload` và `confirm`)". The phase's own `uploadDirect()` sample calls both with bare `fetch(...)`; `retryUp` (`bang-hang-muc.html:1523`) appears nowhere in the replacement code. → Finding 3.
5. **plan.md acceptance criterion 6** — "Không còn document `Binary` nào **được tạo mới** trong `bim_files`". Unachievable while `bim-wheat.vercel.app` runs `api/files.js:152-164`/`:199-209` against the shared database; the user has no deploy rights there (`CLAUDE.md:8-10`). → Finding 2.
6. **plan.md + phase-04 risk tables** — "Site cũ `bim-wheat.vercel.app` … Thấp | Nó chỉ đọc được file cũ, không thấy file mới." Live probe: `DELETE https://bim-wheat.vercel.app/api/files?id=…` with **no key** → `HTTP 200 {"ok":true}`, versus `HTTP 401` on `bim-ruddy`. It writes and deletes, unauthenticated. → Finding 1.

**Contract Verifier — consumers of the interfaces phase-02 removes**

`POST ?action=chunk` — **4 call/definition sites**, plus 1 unreachable external:
- `api/files.js:152` (handler, being deleted)
- `api/files.js:10` (doc comment)
- `bang-hang-muc.html:1544` (caller, phase-03 deletes it)
- `serve.cjs:137` (second handler; phase-02 says "Không đụng: `serve.cjs`" and phase-04 declares it obsolete — divergence is accepted but must be written down, not left implicit)
- **external, not in repo:** the client bundle served by `bim-wheat.vercel.app`, which cannot be updated.

`POST ?action=finish` — **3 sites** + external:
- `api/files.js:167` (handler, being deleted), `api/files.js:12` (doc comment), `bang-hang-muc.html:1555-1556` (caller) — plus `serve.cjs:76` (comment) and the same un-updatable external client.

`DELETE ?chunks=` — **3 sites** + external:
- `api/files.js:213` (handler, being deleted), `api/files.js:217` (`kind:"chunk"` safety filter), `bang-hang-muc.html:1533` (`dropChunks`, phase-03 deletes it) — plus the external client.

`f.url` (the contract phase-02 keeps emitting from `confirm`) — **3 consumers**, all preserved correctly by the plan:
- `bang-hang-muc.html:1386` (`a.href`, the 302 target), `bang-hang-muc.html:1570` (`downloadChunked` appends `&part=`, legacy only), `bang-hang-muc.html:3072` (sanitiser: drops any file entry lacking `f.url || f.dataUrl` — new R2 entries carry `url`, so this passes).

`getRole`/`safeEqual` (kept unchanged) — **3 implementations**: `api/data.js:24,29`; `api/files.js:30,35`; `serve.cjs:37,42`. Phase-04 proposes deleting the "sửa cả ba" note from `CLAUDE.md`; that is a documentation change only and does not alter these three copies, which remain byte-identical and will drift silently.

Note on `safeEqual` itself (`api/files.js:30-34`): it SHA-256s both inputs before `timingSafeEqual`, so the length-mismatch throw and the length-leak of a naive comparison are both avoided — no timing finding here. The weakness is the model, not the primitive: one shared secret per role, plaintext in `localStorage` (`bang-hang-muc.html:966-974`), no per-user identity, no revocation short of a redeploy, and no rate limiting on the compare — which is what makes Finding 3's "an `EDIT_KEY` holder" a much larger population than it looks.
