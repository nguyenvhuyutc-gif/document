# Red Team Review — Failure Mode Analyst

**Target:** `plans/260903-1205-chuyen-file-sang-r2/` (plan.md + phases 01–04)
**Perspective:** Murphy's Law — races, data loss, cascading failure, recovery gaps, deployment/rollback holes
**Verification tier:** Standard (Fact Checker + Contract Verifier)

---

## Finding 1: Rollback and the second deployment both serve new R2 files as HTTP 200 with 0 bytes — cached `immutable` for one year

- **Severity:** Critical
- **Location:** `plan.md`, "Rủi ro toàn cục" row `Site cũ bim-wheat.vercel.app` (line 123); and the total absence of a rollback section in all five plan files
- **Flaw:** The plan states as its mitigation that the old deployment *"chỉ đọc được file cũ, không thấy file mới"* (only reads old files, does not see new ones) and rates it **Thấp**. That claim is factually false. Old code sees the new metadata documents perfectly well and returns them as a **successful, empty, permanently-cached download**. The same code path is what `vercel rollback` restores, which is why the plan has no viable rollback.

- **Failure scenario:**
  A new-shape document `{_id, name, type, size, key, createdAt}` (plan.md:82) has no `data` and no `chunks`. Feed it to the currently deployed handler:
  1. `api/files.js:110` — `findOne({_id: id})` finds it.
  2. `api/files.js:113-114` — `Array.isArray(doc.chunks)` is false, `?part=` branch skipped.
  3. `api/files.js:129` — `Array.isArray(doc.chunks)` false → `api/files.js:138` `buf = docBuffer(doc)`.
  4. `api/files.js:76-78` — `doc.data` is `undefined` → `Buffer.from(doc.data || "")` → **zero-length Buffer**. No throw, no 404.
  5. `api/files.js:140-147` — sets the correct `Content-Type`, the correct Vietnamese `Content-Disposition` filename, `Content-Length: 0`, `Cache-Control: public, max-age=31536000, immutable`, and `res.status(200).send(buf)`.

  The row that renders the link comes from the **same shared MongoDB** via `api/data.js:155-158`, so the `bim-wheat` user sees the file chip and the correct filename. They click, get a 200, and receive a 0-byte `.rvt`. Revit reports a corrupt file. Nothing anywhere logs an error. And because of the `immutable, max-age=31536000` header at `api/files.js:146`, that empty response is pinned in their browser cache **for a year** — so even after you deploy the fix, or roll forward again, that user keeps downloading 0 bytes until they manually clear site data.

  Now apply the same trace to rollback. Phases 2+3 ship, users upload for two days, something breaks, you run `vercel rollback`. Every file uploaded in those two days becomes a silent 0-byte download, cached immutably. **Rolling back does not restore a working state — it converts a loud failure into a silent data-corruption state that outlives the rollback.**

- **Evidence:**
  - `api/files.js:76-78` — `docBuffer()`: `return doc.data && doc.data.buffer ? Buffer.from(doc.data.buffer) : Buffer.from(doc.data || "")` — the `|| ""` is what turns a missing field into a silent empty file
  - `api/files.js:129`, `api/files.js:138` — the `else` branch that reaches `docBuffer(doc)` for any doc without `chunks`
  - `api/files.js:140-147` — 200 + correct filename + `Cache-Control: public, max-age=31536000, immutable`
  - `api/data.js:155-158` — row data (and therefore the `<a href="api/files?id=…">` link) lives in the shared `bim_app` collection, so the old site absolutely renders links to new files
  - `bang-hang-muc.html:1386` — `a.href = f.url || f.dataUrl || "#"` renders the link from whatever the shared row data contains
  - `plan.md:123` — the incorrect "Thấp / không thấy file mới" risk assessment
  - `grep -rn "rollback\|quay lui\|hoàn tác" plans/260903-1205-chuyen-file-sang-r2/` → 0 hits

- **Suggested fix:** Two things, both cheap and both mandatory before Phase 2 ships.
  (a) **Ship a defensive read guard to production FIRST, as its own deploy**, before any R2 code: in the current `api/files.js`, if a doc has neither `data` nor `chunks`, return `410 { ok:false, error:"File này lưu ở kho mới — hãy mở bim-ruddy.vercel.app" }` instead of falling through to `docBuffer`. That deploy is a no-op for today's data and is what makes rollback safe afterwards. It cannot fix `bim-wheat` (no deploy rights) — but see (c).
  (b) Never set `Cache-Control: immutable` on any response whose payload can change identity. At minimum, add `Cache-Control: no-store` explicitly to the new `doc.key` 302 branch so a 5-minute presigned URL is never cached behind a stale redirect.
  (c) Add an explicit "Rollback" section to `plan.md` stating what state is left behind (R2 objects that no deployed code can read; `bim_files` docs with `key` that old code mis-serves) and that the only safe rollback is *code rollback + re-point users at the new site*, not a silent `vercel rollback`. For `bim-wheat`, the honest mitigation is the one CLAUDE.md already names — rotate the MongoDB Atlas password — not "chấp nhận".

---

## Finding 2: `scripts/don-file-mo-coi.mjs` can delete the entire bucket, and the plan's two safety rails do not cover the way it actually fails

- **Severity:** Critical
- **Location:** Phase 4, "Script dọn file mồ côi" (phase-04:83-95) and completion criterion phase-04:111
- **Flaw:** Step 2 of the script spec is *"Lấy toàn bộ `key` trong collection **bim_files**"* — a hardcoded database and collection name. Both are environment-configurable in the code this script is meant to mirror, and the plan itself instructs the operator to populate `.env` in a way that pulls the **wrong environment**. The 7-day threshold protects only in-flight uploads; it is not a defense against an empty key set, and in that scenario it actively makes things worse by preserving only the newest files and destroying everything older.

- **Failure scenario:** Enumerate the ways this script deletes live files:

  1. **Collection/DB drift (whole-bucket wipe).** `api/files.js:23-24` reads `process.env.MONGODB_DB || "bim"` and `process.env.MONGODB_FILES_COLLECTION || "bim_files"`. `.claude/skills/deploy-bim/SKILL.md:98,100` documents both as *optional overrides*. If either is ever set on Vercel (or set differently between environments), the script queries a collection that does not exist, gets **zero keys**, classifies **every object in the bucket** as an orphan, and with `--xoa` deletes every file older than 7 days. That is the entire production archive.
  2. **`npm run vercel:env` pulls the wrong environment.** `package.json:17` is `"vercel:env": "vercel env pull .env"` — no `--environment` flag, so Vercel CLI defaults to **development**. Phase 1.4 (phase-01:79-85) tells the operator to run exactly this to populate `.env`. The deploy skill already warns about this: `.claude/skills/deploy-bim/SKILL.md:118` explicitly uses `vercel env pull <file> --environment production`. So the plan's own setup step hands the cleanup script a `.env` that may point at a different `MONGODB_DB` and a different `R2_BUCKET` than production. Dry-run the script against the development env, see a plausible list, re-run with `--xoa` — and the bucket you delete from is not the one you inspected.
  3. **No lower-bound sanity check.** The spec has no "abort if the MongoDB key set is empty / smaller than N / smaller than half the object count" guard. Every failure above manifests as an empty or short key set, and every one of them is silently interpreted as "everything is an orphan".
  4. **Pagination asymmetry.** phase-04:88 mandates pagination for `ListObjectsV2` (the *safe* direction — a truncated object list just skips work). It says nothing about the MongoDB side, which is the *dangerous* direction: a partial or errored key read produces false orphans. A `.toArray()` that throws mid-cursor must abort the run, not proceed with what it got.
  5. **The `--xoa` path is never tested.** phase-04:111 requires only *"chạy được ở chế độ khô, in đúng danh sách"*. The destructive path ships completely unexercised, one flag away from the only tested path, with no confirmation prompt and no per-object cap.
  6. **In-flight uploads across the 7-day line.** The threshold is measured from R2 `LastModified`. It correctly protects a PUT that finished 10 minutes ago. It does not protect a file whose `confirm` succeeded and then had its metadata deleted by an old-code `DELETE` from `bim-wheat` (see Finding 3, path B) — that object becomes a genuine orphan by the script's definition while a live row still links to it.

- **Evidence:**
  - `phase-04:89` — `Lấy toàn bộ key trong collection bim_files` (hardcoded)
  - `api/files.js:23-24` — `const dbName = process.env.MONGODB_DB || "bim";` / `const filesCollection = process.env.MONGODB_FILES_COLLECTION || "bim_files";`
  - `.claude/skills/deploy-bim/SKILL.md:98,100` — both documented as optional env overrides
  - `package.json:17` — `"vercel:env": "vercel env pull .env"` (no `--environment`)
  - `.claude/skills/deploy-bim/SKILL.md:118` — the correct form the plan does not use
  - `phase-01:84` — the plan instructs `npm run vercel:env`
  - `phase-04:111` — completion criterion covers only the dry-run path

- **Suggested fix:** Have the script `require`/import the same env constants the API uses (`MONGODB_DB`, `MONGODB_FILES_COLLECTION`, `R2_BUCKET`) rather than literals; print the resolved db/collection/bucket and require a typed confirmation of the bucket name before `--xoa`; abort unconditionally if the MongoDB key set is empty or if orphans exceed some fraction (say 20%) of listed objects; abort on any Mongo cursor error rather than proceeding; cap deletions per run. Change `package.json:17` to `vercel env pull .env --environment production`.

---

## Finding 3: Four orphan-producing paths exist; the cleanup script is structurally blind to three of them, and the plan discusses only one

- **Severity:** High
- **Location:** `plan.md` "Rủi ro toàn cục" line 120; Phase 2 risk table (phase-02:184); Phase 4 cleanup spec (phase-04:90)
- **Flaw:** The plan defines an orphan as *"Object có trong R2 mà không có trong MongoDB"* (phase-04:90) and treats the PUT-succeeded-`confirm`-failed case as the only producer. Three other paths produce the **inverse** orphan — an R2 object that *does* have a `bim_files` document but that no table row references. The script cannot see these by construction, so they accumulate forever at up to 200MB each. This directly undermines the project's stated goal of escaping a storage ceiling.

- **Failure scenario:** All four, traced:

  **A. `confirm` OK, `save()` fails (new).** `bang-hang-muc.html:1613` pushes `j.file` into `row[fkey]`; `bang-hang-muc.html:1627-1631` then calls `save()`, which is a **250 ms debounced** `pushToServer` (`bang-hang-muc.html:1109-1110`). If the POST fails, `bang-hang-muc.html:1103` just sets `savePending = false`, toasts, and gives up — there is no retry queue. If the user closes the tab inside that window, `bang-hang-muc.html:3245` fires one best-effort flush that may not complete. Result: R2 object + `bim_files` doc, no row reference. Invisible to the script.

  **B. Row deletion (pre-existing, now expensive).** `doDeleteRows()` at `bang-hang-muc.html:2670-2678` filters rows out of `state.rows` and calls `save()`. It **never** calls `DELETE api/files?id=`. The confirmation dialog is honest about it — `bang-hang-muc.html:2664` says the attachments *"sẽ biến mất khỏi bảng"* (will disappear from the table), not that they are deleted. Under MongoDB this leaked against a 512 MB quota. Under R2 it leaks unmetered 200 MB objects that the script will never flag.

  **C. `removeFile` fire-and-forget (pre-existing, now worse).** `bang-hang-muc.html:1646-1647` removes the entry from the row array and fires `fetch(..., {method:"DELETE"}).catch(function () {})`. The row is saved regardless of outcome. Any 500 / timeout / R2 failure on the server side leaves the object and the doc behind with no reference — and Phase 2 deliberately widens this by returning `ok` even when the R2 delete fails (phase-02:140).

  **D. Old-code delete from `bim-wheat` (new, and the dangerous inversion).** Old `DELETE ?id=` at `api/files.js:225-232` reads only `{chunks:1}`, finds nothing to fan out to, and does `deleteOne({_id:id})`. The **metadata is gone, the R2 object is not**. Now the object *is* a script-visible orphan and gets deleted after 7 days — while a live row on `bim-ruddy` still points at it. A user on the new site deletes a file on the old site, and 7 days later a *different* team's live attachment is destroyed by your cleanup script. This is the one case where the script deletes a file that a user considers live, and it is caused precisely by the shared-database situation the plan rates "Thấp".

- **Evidence:**
  - `bang-hang-muc.html:1613`, `1627-1631`, `1109-1110`, `1103`, `3245` — path A
  - `bang-hang-muc.html:2670-2678`, `2664` — path B
  - `bang-hang-muc.html:1646-1647` — path C (`.catch(function () {})`)
  - `api/files.js:225-232` — path D (old delete removes doc, cannot touch R2)
  - `phase-04:90` — the orphan definition that misses A/B/C
  - `phase-02:140` — "Xóa object R2 hỏng thì vẫn xóa metadata và trả ok"

- **Suggested fix:** Redefine the cleanup script to run **both** directions: (i) R2 objects with no `bim_files` doc (as planned), and (ii) `bim_files` docs whose `_id` appears in no `files`/`filesDuyet`/`filesChapThuan` array of any document in `bim_app` — reporting, not deleting, until it has been trusted for a while. Make `doDeleteRows` collect attached file ids and issue the deletes (or at least record them for the sweeper). Have `removeFile` await the DELETE and only then drop the entry. And for path D specifically, the 7-day threshold must be raised or the sweep must be gated until `bim-wheat` is cut off.

---

## Finding 4: Quadrupling `MAX_UPLOAD` quadruples a window in which the client blocks sync and then blind-overwrites every other user's edits

- **Severity:** High
- **Location:** Phase 3, "Hằng số" (phase-03:120-125) and completion criterion phase-03:151 ("Chọn 3 file cùng lúc")
- **Flaw:** The save protocol is a **full-document, last-writer-wins overwrite with no version check**, and its only reconciliation mechanism is disabled for the entire duration of an upload. Raising the per-file cap from 50 MB to 200 MB, while explicitly testing 3-file multi-select, turns a seconds-long race into a multi-minute one. Neither `plan.md`'s global risk table (lines 116-123) nor Phase 3's risk table (phase-03:161-166) mentions concurrency at all.

- **Failure scenario:**
  1. `handleFilesSelected` sets `filesBusy = true` at `bang-hang-muc.html:1593` and holds it until the whole chain resolves at `bang-hang-muc.html:1628`.
  2. The 4-second poll at `bang-hang-muc.html:1126` short-circuits on `filesBusy` — so for the entire upload, `state.rows` is frozen and never reconciled with the server.
  3. When the chain finishes, `save()` → `pushToServer()` serializes **the whole in-memory state**: `bang-hang-muc.html:1096` `JSON.stringify({rows: state.rows, people: state.people, statuses: state.statuses})`.
  4. `api/data.js:155-158` applies it as `updateOne({_id: planId}, {$set: {data: payload, updatedAt}}, {upsert:true})` — a wholesale replacement. No `mtime` precondition is sent or checked.

  Concretely: engineer A selects three 200 MB `.rvt` files. On a 10 Mbps office upstream that is roughly 8 minutes. During those 8 minutes engineer B renames five items, changes three statuses, adds two rows and two attachments — all saved. When A's uploads finish, A's tab POSTs the 8-minute-old `state.rows` and **every one of B's edits is destroyed**, silently, with a green "Đã đính kèm 3 file" toast. B's next 4-second poll pulls A's stale document down and overwrites B's own screen. There is no conflict indication and no undo.

  Under the current 50 MB cap this window was ~2 minutes for one file. The plan quadruples it and adds a test that maximises it, without ever naming the hazard.

- **Evidence:**
  - `bang-hang-muc.html:1297` — current `var MAX_UPLOAD = 50 * 1024 * 1024;`
  - `phase-03:123` — `var MAX_UPLOAD = 200 * 1024 * 1024;   // 50MB → 200MB`
  - `bang-hang-muc.html:1593` / `1628` — `filesBusy` held for the whole chain
  - `bang-hang-muc.html:1126` — `if (savePending || filesBusy || ...) return;` disables the only sync path
  - `bang-hang-muc.html:1096` — full-state payload
  - `api/data.js:155-158` — unconditional full-document `$set`, no optimistic concurrency
  - `bang-hang-muc.html:1137` — the poll's own wholesale `state.rows = j.data.rows`
  - `phase-03:151` — "Chọn 3 file cùng lúc → cả 3 lên đủ"

- **Suggested fix:** Do not hold `filesBusy` across the R2 PUT — the PUT no longer touches your server, so there is no reason to freeze sync during it. Set `filesBusy` only around `sign-upload`/`confirm`/`save`. Better: make the attachment write a **targeted, additive** operation instead of riding the whole-document save — have `confirm` (which already knows `id`, and could take `plan` + `row` + `fkey`) `$push` the file entry into the row server-side, so an attachment can never be lost to a stale full-document overwrite. At minimum, send `serverMtime` with the POST and have `api/data.js` reject the write if it does not match, so the client can re-merge.

---

## Finding 5: `confirm` is not idempotent — a retry after a successful insert returns 500, and the client then never saves the row

- **Severity:** High
- **Location:** Phase 2, "`POST ?action=confirm`" (phase-02:96-109); Phase 3, `uploadDirect` (phase-03:61-68) vs. phase-03:138
- **Flaw:** `confirm` ends in `insertOne({_id: id, ...})` (phase-02:104) with a client-supplied `id`. The plan simultaneously says confirm is wrapped in `retryUp` (phase-03:138: *"retryUp (vẫn dùng cho sign-upload và confirm)"*) and shows code that does **not** wrap it (phase-03:61-68). Both readings fail, in different ways, after a 200 MB upload has already succeeded.

- **Failure scenario:**

  **If `retryUp` is used (per phase-03:138).** The first `confirm` reaches MongoDB, `insertOne` succeeds, and the response is lost (connection reset, Vercel cold-start hiccup, phone switching from Wi-Fi to LTE). `retryUp` (`bang-hang-muc.html:1523-1528`) fires attempt 2 after 900 ms. `insertOne` with the same `_id` throws **E11000 duplicate key**, which falls into the catch at `api/files.js:236-238` → `res.status(500).json({ok:false, error:"E11000 duplicate key error..."})`. The client's `apiJson` (`bang-hang-muc.html:1515-1521`) parses that fine, so it does not throw; `bang-hang-muc.html:1613` sees `j.ok === false` and falls to the `else` at `1615`, toasting a raw MongoDB error string in English. `okCount` stays 0 → `bang-hang-muc.html:1629` `if (okCount)` is false → **`save()` is never called**. The 200 MB file exists in R2, its metadata exists in `bim_files`, and no row references it — Finding 3 path A, permanently invisible to the cleanup script. The user, told the upload failed, uploads it again: a second 200 MB object.

  **If `retryUp` is not used (per the actual code sketch).** A single transient blip on the confirm request discards a completed 200 MB upload with zero recovery, and the R2 object is a true orphan. Phase 3's criterion *"Ngắt mạng giữa chừng → báo lỗi rõ ràng"* (phase-03:152) does not distinguish "PUT failed, nothing uploaded" from "PUT succeeded, 200 MB burned", so manual testing will not surface the difference.

- **Evidence:**
  - `phase-02:104` — `insertOne { _id: id, ... }`
  - `phase-02:89` — `id` minted at `sign-upload` and round-tripped through the client, so it is stable across retries (which is exactly what makes the duplicate collide)
  - `phase-03:138` vs `phase-03:61-68` — the contradiction
  - `bang-hang-muc.html:1523-1528` — `retryUp` retries the whole request, including a request that already had server-side effect
  - `api/files.js:236-238` — the catch-all that turns E11000 into a 500
  - `bang-hang-muc.html:1515-1521` — `apiJson` only throws on unparseable bodies, so `{ok:false}` flows through as a normal value
  - `bang-hang-muc.html:1613-1618`, `1629` — `okCount` gating means a failed confirm suppresses `save()` entirely

- **Suggested fix:** Make `confirm` idempotent: `updateOne({_id:id}, {$setOnInsert:{...}}, {upsert:true})`, or catch E11000 and return the existing document with `ok:true`. Either way it must return the same `{ok:true, file:{...}}` shape on a repeat call, so a retry converges. Add a completion criterion: "calling `confirm` twice with the same id returns 200 both times and creates exactly one document."

---

## Finding 6: Phase 4 mandates testing on a preview deploy that writes into production MongoDB and the production R2 bucket

- **Severity:** High
- **Location:** Phase 4, "Kiểm thử — làm trên bản **preview** trước" (phase-04:16-44); Phase 1.4 "cả 3 môi trường" (phase-01:70)
- **Flaw:** Preview and production share `MONGODB_URI` and — by Phase 1.4's own instruction to set the R2 vars identically across all three environments — the same `R2_BUCKET`. There is no test plan, no test database, no cleanup step, and no acknowledgement anywhere that the 13-row matrix is being executed against live data that other people are editing at the same time.

- **Failure scenario:**
  - `.claude/skills/deploy-bim/SKILL.md:102` — *"Cả 3 biến đầu đã set cho production/preview/development"* — preview reads the same `MONGODB_URI`, therefore the same `bim_app` and the same `bim_files`.
  - `phase-01:70` — set the four R2 vars *"cả 3 môi trường"*, with `R2_BUCKET = bim-files` for all of them → one bucket.
  - The tester opens the preview URL. `bang-hang-muc.html:1117-1145` starts the same 4-second poll against the same production plans. Matrix rows 1/3/4 (phase-04:30-33) upload a real ~200 MB `.rvt`, a 20 MB `.dwg` and a 5 MB JPG into a **real production row**. Four seconds later every production user sees them appear.
  - Row 10 (phase-04:39) deletes one of them. Rows 2, 3, 4, 6, 7 leave debris that no step removes — phase-04:103-112's completion criteria contain no "test rows/files cleaned up" item.
  - Meanwhile the tester's own tab is a full participant in the last-writer-wins overwrite of Finding 4. A ~200 MB upload from a preview URL will clobber whatever production users edited during it.
  - Row 12 (phase-04:41) requires waiting >5 minutes with the tab open — 75+ polls against production during a deliberate idle.

  There is also a workflow trap layered on top: `npm run deploy:preview` (`package.json:13` → `vercel deploy`) mints a **new hostname per deployment**. R2 CORS `AllowedOrigins` takes exact origins, so the operator must add the new preview origin to the bucket policy **before every preview deploy**. phase-01:66 treats this as optional (*"nếu có ý định test"*) and phase-04:118 treats it as a one-time note, but Phase 4 makes preview testing mandatory. Every re-deploy during a debug loop hits a CORS error that looks identical to the signature errors the plan is trying to avoid.

- **Evidence:**
  - `.claude/skills/deploy-bim/SKILL.md:102` — shared env across all three targets
  - `phase-01:70` — "cả 3 môi trường" with one `R2_BUCKET` value (phase-01:77)
  - `phase-04:16-24` — mandatory preview deploy for testing
  - `phase-04:30-42` — the matrix rows that write and delete live data
  - `phase-04:103-112` — completion criteria with no cleanup requirement
  - `bang-hang-muc.html:1117-1145` — preview tab polls and writes production plans identically
  - `api/data.js:155-158` — the shared-collection write
  - `package.json:13` — `"deploy:preview": "vercel deploy"` (new URL each time)
  - `phase-01:58` — CORS `AllowedOrigins` lists only `bim-ruddy.vercel.app` and `http://localhost:3000`

- **Suggested fix:** Give preview its own `MONGODB_DB` (e.g. `bim_preview`) and its own `R2_BUCKET` (`bim-files-preview`) — this is a per-environment env value on Vercel, roughly ten minutes of work, and it removes an entire class of risk including the cleanup-script drift in Finding 2. Failing that: create a dedicated throwaway plan via `?action=create` and require every matrix row to run inside it, plus an explicit teardown criterion. Add a preview-CORS entry (or a wildcard preview origin) to Phase 1.3 as a required, not optional, step.

---

## Finding 7: Module-level R2 client construction abandons the project's lazy-env pattern; a missing or empty R2 variable either takes down old-file downloads or silently produces `https://undefined…`

- **Severity:** High
- **Location:** Phase 2, "Kiến trúc / Ký URL" (phase-02:36-46); Phase 2 completion criteria (phase-02:162-176)
- **Flaw:** The plan puts `new AwsClient({...})` and the `R2_BASE` template literal at module top level, reading four `process.env` values that do not exist yet. The existing code deliberately does the opposite: `api/files.js:22` reads `MONGODB_URI` at module scope but validates it **lazily** inside `connectMongo()` at `api/files.js:46`, so a missing variable produces a contained, readable per-request error and never breaks a code path that does not need Mongo. Phase 2 breaks that pattern and adds no env validation at all — `grep -rn "R2_ACCOUNT_ID\|R2_BUCKET" plans/` shows the four variables are listed in tables and never checked in any code sketch.

- **Failure scenario:** Env vars and code deploy independently, and this project has already been bitten by it — `.claude/skills/deploy-bim/SKILL.md:104-116` documents a **known trap in this exact repo** where `vercel env add` creates variables with **empty values**, and warns that after changing env you *"phải deploy lại"*. So "code is live, R2 vars are absent or empty strings" is not hypothetical here; it is the documented default failure of the tooling.

  Two divergent outcomes, both bad:

  **(a) Construction throws.** If `new AwsClient({accessKeyId: undefined, secretAccessKey: undefined})` throws at import time, the module never loads and **the entire `/api/files` function 500s** — including `GET ?id=` for the old MongoDB-resident files, which have nothing whatsoever to do with R2. A missing R2 credential takes down downloads of the legacy data the whole hybrid-read-path design exists to protect. The deploy skill's smoke test (`.claude/skills/deploy-bim/SKILL.md:88`) only checks `/` and `/api/data` and explicitly says a bare `/api/files` returning 400 is normal — it would not distinguish this.

  **(b) Construction succeeds with garbage.** `R2_BASE` becomes `https://undefined.r2.cloudflarestorage.com/undefined`, `sign-upload` returns **HTTP 200 with a well-formed-looking `uploadUrl`**, and the failure surfaces two steps later as `xhr.onerror` → the client toasts `"mất kết nối khi tải lên"` (phase-03:57). That message sends the debugger straight at the network and the CORS policy — the exact rabbit hole Phase 1 spends a whole section trying to avoid — when the real cause is a blank env var.

- **Evidence:**
  - `phase-02:37-46` — module-level `const r2 = new AwsClient({...})` and `const R2_BASE = ...${process.env.R2_ACCOUNT_ID}...`
  - `api/files.js:22` + `api/files.js:46` — the existing lazy pattern (`if (!uri) throw new Error("MONGODB_URI is not configured")` inside `connectMongo`)
  - `.claude/skills/deploy-bim/SKILL.md:104-116` — the documented empty-env trap and the "must redeploy after env change" rule
  - `.claude/skills/deploy-bim/SKILL.md:88` — the post-deploy smoke test that would not catch this
  - `phase-03:57` — `xhr.onerror = function () { reject(new Error("mất kết nối khi tải lên")); }` — the misleading symptom
  - `phase-02:162-176` — 13 completion criteria, none covering a missing or empty R2 variable

- **Suggested fix:** Wrap the client in `function getR2()` that lazily constructs on first use and throws a named error listing exactly which of the four variables is missing or empty (`if (!process.env.R2_BUCKET) throw new Error("R2_BUCKET is not configured")`), mirroring `connectMongo()`. Keep the `data`/`chunks` GET branches reachable without ever calling `getR2()`. Add a completion criterion: "with the R2 vars unset, `GET ?id=` on an old file still returns its content, and `sign-upload` returns a 500 naming the missing variable."

---

## Finding 8: `confirm` verifies the upload by sending HEAD to a URL presigned for GET — the method is part of the SigV4 signature

- **Severity:** High
- **Location:** Phase 2, "`POST ?action=confirm`" (phase-02:101-103)
- **Flaw:** The spec says *"HEAD lên presigned GET của key"*. In SigV4 the HTTP method is the **first line of the canonical request**, so a URL signed for `GET` and then issued as `HEAD` produces a different canonical request and a different signature. AWS S3 is lenient about this in some paths; R2's S3-compatible SigV4 verifier is not something to bet the upload path on. The plan's own helper already takes the method as a parameter — `signR2(key, method, expires, extraQuery)` at phase-02:49 — so the prose contradicts the helper it is calling, and the fix is one word.

- **Failure scenario:** If R2 rejects it, **every `confirm` fails, 100% of the time**, and it fails down the plan's own "file not found" branch: phase-02:102 → `400 "Chưa thấy file trên kho lưu trữ"`. So every 200 MB upload completes its PUT successfully and is then declared missing. The user, reading "file not yet in storage", retries — producing a second 200 MB orphan per attempt. The error message actively points at the wrong cause: it says the file is not there, when the file is there and the signature is wrong. This is discoverable at test time (phase-02:168-169 covers it), which is why it is High rather than Critical — but it will burn an afternoon in exactly the way Phase 1 was designed to prevent, and it costs nothing to avoid.

  Compounding it: the `confirm` handler now makes an outbound network call to R2 inside a serverless invocation, and neither the code sketch nor `vercel.json` bounds it. `vercel.json` has **no `functions` block and no `maxDuration`**, so whatever the platform default is applies; a hung or slow HEAD burns the whole budget and returns a platform error page (HTML), which `apiJson` (`bang-hang-muc.html:1515-1521`) turns into `"máy chủ trả lỗi HTTP 504"` — again after the 200 MB has already been transferred.

- **Evidence:**
  - `phase-02:101` — `HEAD lên presigned GET của key`
  - `phase-02:49` — `async function signR2(key, method, expires, extraQuery)` — the method parameter the prose ignores
  - `phase-02:102` — the misleading 400 that a signature mismatch would trigger
  - `vercel.json:1-14` — no `functions` key, therefore no `maxDuration`
  - `bang-hang-muc.html:1515-1521` — `apiJson` converts an HTML platform error into `"máy chủ trả lỗi HTTP <status>"`
  - `plan.md:119` — the plan already identifies signature mismatch as a "Cao" risk and mitigates only the `Content-Type` variant of it

- **Suggested fix:** Sign specifically for the method used: `signR2(key, "HEAD", 300)`, and state it that way in the plan text. Wrap the fetch in an `AbortController` with a short timeout (5 s) and treat a timeout as a distinct, retriable outcome ("chưa xác minh được — thử lại") rather than the "file not found" 400. Add an explicit `functions.maxDuration` to `vercel.json` so the budget is a decision rather than a default.

---

## Finding 9: The Phase 2 removal list is incomplete and self-contradictory — it deletes `readRawBody()` but never the single-request upload branch that is its only remaining caller

- **Severity:** Medium
- **Location:** Phase 2, "Gỡ bỏ" table (phase-02:143-156) and "Bốn nhánh xử lý" (phase-02:81-141)
- **Flaw:** The removal table lists `action=chunk`, `action=finish`, `DELETE ?chunks=`, `readRawBody()`, `MAX_BYTES` and the `Binary` import. It never mentions the **plain `POST ?name=&type=` single-request upload branch** at `api/files.js:186-209` — which is the branch today's client uses for every file under 3.5 MB, i.e. the most common upload in the system. That branch calls `readRawBody(req)` at `api/files.js:191`, checks `MAX_BYTES` at `api/files.js:197`, and writes `new Binary(buf)` at `api/files.js:205`. An implementer following the table literally deletes all three dependencies and keeps the caller: `ReferenceError: readRawBody is not defined` → `api/files.js:236-238` → 500. The "Bốn nhánh xử lý" section implies the branch is gone; the removal table implies it stays. Both cannot be true, and the plan's completion criteria (phase-02:162-176) check for the absence of `action=chunk`/`action=finish` but never for this branch.

- **Failure scenario (cached clients).** `bang-hang-muc.html` is served as a plain static file and `vercel.json:5-13` sets headers only for `/api/(.*)` — nothing controls the HTML's caching or forces a reload. Tabs left open over a weekend, and browser-cached copies, will keep calling four now-dead endpoints:
  - `bang-hang-muc.html:1609` — `POST api/files?name=&type=` (files ≤ 3.5 MB)
  - `bang-hang-muc.html:1544` — `POST api/files?action=chunk`
  - `bang-hang-muc.html:1555` — `POST api/files?action=finish`
  - `bang-hang-muc.html:1533` — `DELETE api/files?chunks=`

  Falling through to `api/files.js:234` yields `{ok:false, error:"Method Not Allowed"}`. `apiJson` parses it cleanly, so no exception is raised; `bang-hang-muc.html:1615-1617` toasts the raw English string **"Method Not Allowed"** to a Vietnamese-language user. For a large file it is worse: `retryUp(..., 3)` at `bang-hang-muc.html:1543-1552` retries every chunk three times at 900 ms intervals before failing, so a 40 MB file grinds for several minutes with the cell greyed out (`bang-hang-muc.html:1595`) before surfacing an untranslated error. No data is lost (`okCount` stays 0 so `save()` is skipped), but there is no version check, no forced reload, and no mention of this in any phase.

  Two smaller defects in the same area, both worth fixing while the file is open:
  - The `DELETE ?id=` sketch at phase-02:132-137 reads `doc.key` with **no null guard**. The code it replaces has one: `api/files.js:226` `if (doc && Array.isArray(doc.chunks) && doc.chunks.length)`. Deleting an already-deleted file — trivially reachable, since `removeFile` fires and forgets and two tabs or two users can both act on a poll-synced row — throws a TypeError into `api/files.js:236-238` and returns 500 instead of the old graceful 200.
  - Phase 3 removes `uploadChunked`/`CHUNK_SIZE` from `bang-hang-muc.html`, which is the **same file `serve.cjs` serves** (`serve.cjs:77`). In LAN mode `SERVER_MODE` is true, so the new `uploadDirect` will POST `?action=sign-upload` to `serve.cjs`, which has no such action and falls through to `serve.cjs:170-175`, reading an empty body and returning `400 {ok:false, error:"File rỗng"}`. Every LAN upload will fail with "File rỗng". The plan declares `serve.cjs` abandoned (phase-04:70) and adds a README note — but `package.json:6,8-10` still ships `main: serve.cjs` and `npm start`/`dev`/`serve`, and `start-server.bat` is still in the repo, so anyone following the existing docs gets a silent, confusing break.

- **Evidence:**
  - `api/files.js:186-209` — the single-request POST branch omitted from the removal table
  - `api/files.js:191`, `197`, `205` — its dependencies on `readRawBody`, `MAX_BYTES`, `Binary`, all three of which phase-02:143-156 removes
  - `api/files.js:234` — the 405 fallthrough; `api/files.js:236-238` — the 500 catch-all
  - `bang-hang-muc.html:1609`, `1544`, `1555`, `1533` — the four cached-client callers
  - `bang-hang-muc.html:1515-1521`, `1615-1617` — `{ok:false}` flows through as data and gets toasted verbatim
  - `bang-hang-muc.html:1543-1552` — 3× retry per chunk before failing
  - `vercel.json:5-13` — headers scoped to `/api/(.*)` only; no HTML cache control
  - `api/files.js:226` vs `phase-02:133` — the dropped null guard
  - `serve.cjs:77`, `serve.cjs:170-175`; `package.json:6,8-10` — the LAN break

- **Suggested fix:** Add the plain `POST ?name=&type=` branch to the removal table explicitly. Keep a short-lived compatibility shim: have the removed actions return `426 {ok:false, error:"Bản web đã cập nhật — hãy tải lại trang (Ctrl+F5)"}` and have the client show that message and offer a reload, rather than falling through to a 405. Restore the `if (!doc)` guard in `DELETE ?id=` and return 200 for an already-deleted file. If `serve.cjs` is genuinely dead, delete `npm start`/`dev`/`serve` and `start-server.bat` in the same change so nothing silently half-works.

---

### Verification Results

**Tier:** Standard (Fact Checker + Contract Verifier)
**Claims checked:** 24 across 4 phases + plan.md
**VERIFIED:** 19 · **FAILED:** 4 · **UNVERIFIED:** 1

**Fact Checker — verified claims**

| # | Claim (source) | Result |
|---|---|---|
| 1 | `bang-hang-muc.html:1386` renders the download link as `a.href = f.url \|\| f.dataUrl \|\| "#"` (plan.md:39,42) | VERIFIED — `bang-hang-muc.html:1386` |
| 2 | Line 1389 sets `data-chunks` (phase-03:137) | VERIFIED — `bang-hang-muc.html:1389` |
| 3 | Line 2297 calls `downloadChunked` (phase-03:137) | VERIFIED — `bang-hang-muc.html:2297` |
| 4 | `dropChunks()` at 1531 (phase-03:131) | VERIFIED — `bang-hang-muc.html:1531` |
| 5 | `uploadChunked()` at 1536 (phase-03:132) | VERIFIED — `bang-hang-muc.html:1536` |
| 6 | `CHUNK_SIZE` at 1298 (phase-03:133) | VERIFIED — `bang-hang-muc.html:1298` |
| 7 | `.uploading` class added at line 1595 (phase-03:82) | VERIFIED — `bang-hang-muc.html:1595` |
| 8 | `.files-cell.uploading` CSS at lines 377–379 (phase-03:82) | VERIFIED — `bang-hang-muc.html:377-379` |
| 9 | `--accent-weak` exists at lines 66 and 74, light + dark (phase-03:103) | VERIFIED — `bang-hang-muc.html:66,74` (also 28, 53 in the `prefers-color-scheme` blocks) |
| 10 | `--accent-soft` does not exist (phase-03:103) | VERIFIED — 0 hits repo-wide |
| 11 | `engines` pins Node `22.x` (phase-02:185) | VERIFIED — `package.json:26-28` |
| 12 | `getRole` / `safeEqual` exist and are reusable (phase-02:29) | VERIFIED — `api/files.js:30-42` |
| 13 | `docBuffer()` exists and is retained (phase-02:154) | VERIFIED — `api/files.js:76-78` |
| 14 | `connectMongo` exists and is retained (phase-02:155) | VERIFIED — `api/files.js:44-56` |
| 15 | `asciiName` + `filename*=UTF-8''` construction exists (phase-02:126) | VERIFIED — `api/files.js:141,144-145` |
| 16 | `MAX_BYTES = 4.4MB` exists (phase-02:151) | VERIFIED — `api/files.js:26` |
| 17 | `readRawBody()` exists (phase-02:150) | VERIFIED — `api/files.js:58-74` |
| 18 | `DELETE ?chunks=` loose-cleanup branch exists (phase-02:149) | VERIFIED — `api/files.js:213-220`, auth exemption at `api/files.js:90-94` |
| 19 | `.gitignore` blocks `.env*` with `!.env.example` (phase-01:135) | VERIFIED — `.gitignore:14-15` |

**FAILED claims**

1. **plan.md:123** — *"Site cũ bim-wheat.vercel.app … chỉ đọc được file cũ, **không thấy file mới**"*, rated **Thấp**. FAILED. Old code reads new-shape docs and returns HTTP 200 with a 0-byte body and a one-year `immutable` cache header. Trace: `api/files.js:110` → `129` (false) → `138` `docBuffer(doc)` → `76-78` `Buffer.from(undefined || "")` → `140-147`. See Finding 1.
2. **phase-01:58** — CORS `AllowedOrigins` includes `http://localhost:3000`. FAILED as a useful entry. The project's local server runs on **8787** (`CLAUDE.md` command table; `SO-TAY-CAU-LENH.md:250` shows `http://localhost:8787`), and nothing in the repo binds 3000. The origin that actually needs adding is the per-deploy Vercel preview host, which Phase 4 requires but Phase 1 lists as optional.
3. **phase-04:89** — *"Lấy toàn bộ `key` trong collection **bim_files**"*. FAILED as a safe specification. The collection is env-configurable (`api/files.js:24`, `.claude/skills/deploy-bim/SKILL.md:100`) and so is the database (`api/files.js:23`); a hardcoded literal that misses yields an empty key set and marks the whole bucket orphaned. See Finding 2.
4. **phase-02:143-156 "Gỡ bỏ" table** — FAILED for completeness. Removes `readRawBody()` and `MAX_BYTES` but omits `api/files.js:186-209`, the single-request `POST ?name=&type=` upload branch that is their only remaining caller (`api/files.js:191,197,205`). See Finding 9.

**UNVERIFIED**

1. **phase-02:101** — whether R2 accepts a `HEAD` request against a URL presigned for `GET`. Not testable from this repo (no R2 credentials, no network fixture). The SigV4 canonical request includes the HTTP method, so the safe reading is that it does not; the plan's own `signR2(key, method, ...)` helper (phase-02:49) makes signing for `HEAD` free. See Finding 8.

**Contract Verifier — consumer enumeration**

*Consumers of the `bim_files` collection (`MONGODB_FILES_COLLECTION`) — 3 code sites, 1 planned:*
1. `api/files.js:24` — declaration; used at `api/files.js:106` (`db.collection(filesCollection)`), reached by GET (`:108-149`), `action=chunk` (`:152-165`), `action=finish` (`:167-184`), plain POST (`:186-209`), `DELETE ?chunks=` (`:213-220`), `DELETE ?id=` (`:223-232`). **Phase 2 rewrites all of these.**
2. The **`bim-wheat.vercel.app` deployment** — a second live copy of this same file, on the same `MONGODB_URI`, that Phase 2 cannot update (CLAUDE.md, "Site cũ"). Its GET path silently mis-serves new docs (Finding 1) and its DELETE path (`api/files.js:225-232`) removes new metadata while leaving the R2 object (Finding 3 path D). **Not accounted for beyond a "Thấp" rating.**
3. `scripts/don-file-mo-coi.mjs` — planned (phase-04:85-95), a fourth consumer with delete authority over R2. **Hardcodes the collection name the other consumers read from env.**
4. `serve.cjs:77-232` — **not** a consumer of `bim_files`; it stores to `data-files/` on disk (`HUONG-DAN-DEPLOY.md:19`). No shared state, but it *does* serve the same `bang-hang-muc.html` (Finding 9).

*Producers of the `row.files` entry shape (`{id, name, size, type, url[, chunks]}`) — 4:*
1. `api/files.js:182` (`finish`, with `chunks`) and `api/files.js:208` (plain POST) — both removed/replaced by Phase 2's `confirm` (phase-02:105)
2. `serve.cjs:166` and `serve.cjs:181` — LAN equivalents, unchanged by the plan
3. `bang-hang-muc.html:1620` — the `file://` / `localStorage` branch producing `{uid, name, size, type, dataUrl, uploadedAt}`
4. `bang-hang-muc.html:1613` — decorates the server response with `uid` and `uploadedAt` before pushing into the row

*Consumers of the `row.files` entry shape — 9, all in `bang-hang-muc.html`:*
| # | Site | Reads | Impact of Phase 2/3 |
|---|---|---|---|
| 1 | `:1381` | `f.uid \|\| f.id` | none |
| 2 | `:1386` | `f.url \|\| f.dataUrl` | none — confirm returns `url` (phase-02:105) |
| 3 | `:1389` | `f.chunks` | none — new docs have no `chunks`, so the plain `<a>` + 302 path is taken. plan.md:39-48 is correct here |
| 4 | `:1457` | `uid \|\| id` (note lookup) | none |
| 5 | `:1484` | `uid \|\| id` (note lines) | none |
| 6 | `:1568-1570` | `f.chunks`, `f.url + "&part="` | must survive Phase 3's deletions — phase-03:136 correctly flags this |
| 7 | `:1642-1647` | `uid \|\| id`, `removed.id` → `DELETE ?id=` | fire-and-forget; see Finding 3 path C |
| 8 | `:2296` | `x.uid \|\| x.id` (chunked-download dispatch) | none |
| 9 | `:3072` | **drops any entry lacking `f.url` or `f.dataUrl`** in `normalizeRowShape` | **Hard contract.** If `confirm` ever omits `url` from its response, every affected attachment is silently deleted from the row on the next load or poll. Phase 2 satisfies it (phase-02:105) but no completion criterion asserts it |

*Row-array keys — 3, not 1:* `files`, `filesDuyet`, `filesChapThuan` (`bang-hang-muc.html:3070`, `:2643`). `handleFilesSelected(rowId, fkey, ...)` is `fkey`-parameterised, so Phase 3's rewrite is safe here, but the cleanup script of Finding 3's suggested reverse sweep must scan all three.

*Test suite:* **none exists.** `find . -name "*.test.*" -o -name "*.spec.*" -o -name "jest.config*" -o -name "vitest*" -o -name "__tests__"` returns 0 results; `package.json:7-19` has no `test` script. The plan's entire verification is the 13-row manual matrix at phase-04:28-42, executed once against live production data. It cannot catch: the E11000 retry path (Finding 5), the concurrent-overwrite race (Finding 4), any missing/empty-env behaviour (Finding 7), cached-client fallout (Finding 9), a stale `global.__mongoClient` after an Atlas idle disconnect (`api/files.js:47-54` caches the client with no health check and never clears it on error, so one dead topology poisons every subsequent request on that warm instance — and each poisoned `confirm` now costs a 200 MB re-upload), or any regression introduced after the single manual pass.
