/* ============================================================================
 * shared_worker.js — SharedWorker กลางของเว็บ (ใช้ร่วมทุกหน้า/ทุกแท็บ)
 * ----------------------------------------------------------------------------
 * ทำ 2 หน้าที่:
 *   1) แคชไฟล์ข้อมูล data/* (json/geojson/tif) ไว้ในหน่วยความจำของ worker
 *      — เว็บนี้ fetch ข้อมูลด้วย ?t=Date.now() (กัน HTTP cache ค้างข้าม deploy)
 *      ทำให้สลับหน้า จำลองน้ำท่วม ↔ แก้โครงสร้าง ต้องโหลดข้อมูลหลาย MB ใหม่ทุกครั้ง
 *      → worker อยู่ข้ามการนำทาง/แท็บ จึงโหลดจริงครั้งเดียวต่อเซสชัน
 *      (คำขอซ้ำไฟล์เดียวกันที่มาพร้อมกันก็ถูกยุบเหลือ fetch เดียว)
 *   2) ดึงข้อมูลสด เขื่อนบางลาง (ThaiWater) + ฝนยะลา (Open-Meteo) ที่เดียว
 *      แล้วแจกทุกหน้า — เปิดหลายแท็บ/สลับหน้าไม่ยิง API ซ้ำ + ป้ายสถานะขึ้นทันที
 *
 * ฝั่งหน้าเว็บคุยผ่าน assets/shared_data.js (มี fallback ถ้าไม่มี SharedWorker)
 * โปรโตคอล: {type:'data',id,url} → {type:'data',id,ok,status,bin,body,hit}
 *           {type:'live',id,maxAge} → {type:'live',id,ok,data,ts}
 *           broadcast {type:'live:update',ok,data,ts} เมื่อ poll รอบใหม่สำเร็จ
 * ========================================================================== */
"use strict";

var ports = [];

/* ---------------- 1) แคชไฟล์ข้อมูล ---------------- */
var cache = {};            // key → { ok, status, bin, body, size }
var inflight = {};         // key → Promise (ยุบคำขอซ้ำระหว่างโหลด)
var lruOrder = [];         // key เรียงตามการใช้ล่าสุด (ท้าย = ล่าสุด)
var totalBytes = 0;
var MAX_BYTES = 96 * 1024 * 1024;   // เพดานแคช ~96MB (ไฟล์ใหญ่สุดในเว็บ ~10MB)
var stats = { hits: 0, misses: 0, revalidated: 0 };

// ตัด ?t=<เลข> ออกจาก key — ไฟล์ data/* คงที่ต่อ deploy · แคชอยู่แค่ช่วงเซสชันเบราว์เซอร์
function keyOf(url) {
  return url.replace(/([?&])t=\d+&?/, "$1").replace(/[?&]$/, "");
}
function touchLRU(key) {
  var i = lruOrder.indexOf(key);
  if (i >= 0) lruOrder.splice(i, 1);
  lruOrder.push(key);
}
function putCache(key, entry) {
  cache[key] = entry;
  totalBytes += entry.size;
  touchLRU(key);
  while (totalBytes > MAX_BYTES && lruOrder.length > 1) {   // เกินเพดาน → ทิ้งตัวเก่าสุด
    var old = lruOrder.shift();
    totalBytes -= cache[old].size;
    delete cache[old];
  }
}

// ชั้นที่สอง: CacheStorage (ดิสก์) — SharedWorker ถูกเบราว์เซอร์ปิดเมื่อ client สุดท้าย
// หลุด (เช่นนำทางในแท็บเดียว) ทำให้แคชหน่วยความจำหาย · เก็บสำเนา+validator ลงดิสก์ไว้
// worker เกิดใหม่จะถาม server แบบ conditional GET (If-None-Match/If-Modified-Since)
// → 304 = ใช้ body เดิมจากดิสก์ (แลกแค่ header ไม่กี่ร้อยไบต์ ไม่โหลด MB ซ้ำ)
// → ไฟล์เปลี่ยน (deploy ใหม่) = 200 มาแทนที่ ไม่มีทางค้างของเก่า
var CACHE_NAME = "yala-data-v1";

async function diskGet(key) {
  try { return await (await caches.open(CACHE_NAME)).match(key); } catch (e) { return null; }
}
async function diskPut(key, entry, etag, lastMod) {
  try {
    var h = { "Content-Type": entry.bin ? "application/octet-stream" : "application/json" };
    if (etag) h["X-Src-Etag"] = etag;
    if (lastMod) h["X-Src-Last-Modified"] = lastMod;
    await (await caches.open(CACHE_NAME)).put(key, new Response(entry.body, { headers: h }));
  } catch (e) { /* ดิสก์เต็ม/ไม่รองรับ — ข้ามได้ แคชหน่วยความจำยังทำงาน */ }
}

function loadData(url) {
  var key = keyOf(url);
  if (cache[key]) {
    stats.hits++;
    touchLRU(key);
    return Promise.resolve(Object.assign({ hit: true }, cache[key]));
  }
  if (!inflight[key]) {
    stats.misses++;
    inflight[key] = (async function () {
      var bin = /\.tif(\?|$)/i.test(key);
      var entry;
      try {
        // มีสำเนาบนดิสก์ → ถามแบบมีเงื่อนไข (304 = ของเดิมยังใช้ได้)
        var disk = await diskGet(key);
        var condHeaders = {};
        if (disk) {
          var et = disk.headers.get("X-Src-Etag"), lm = disk.headers.get("X-Src-Last-Modified");
          if (et) condHeaders["If-None-Match"] = et;
          if (lm) condHeaders["If-Modified-Since"] = lm;
        }
        var r = null;
        try { r = await fetch(url, { headers: condHeaders }); }
        catch (netErr) { r = null; }                        // ออฟไลน์ → ใช้สำเนาดิสก์ถ้ามี

        if (disk && (!r || r.status === 304)) {
          stats.revalidated++;
          var body304 = bin ? await disk.clone().arrayBuffer() : await disk.clone().text();
          entry = { ok: true, status: 200, bin: bin, body: body304,
                    size: bin ? body304.byteLength : body304.length * 2 };
          putCache(key, entry);
          return entry;
        }
        if (!r) return { ok: false, status: 0, bin: bin, body: null, size: 0 };

        var body = bin ? await r.arrayBuffer() : await r.text();
        entry = { ok: r.ok, status: r.status, bin: bin, body: body,
                  size: bin ? body.byteLength : body.length * 2 };
        if (r.ok) {
          putCache(key, entry);                             // แคชเฉพาะที่โหลดสำเร็จ
          diskPut(key, entry, r.headers.get("ETag"), r.headers.get("Last-Modified"));
        }
        return entry;
      } catch (e) {
        return { ok: false, status: 0, bin: bin, body: null, size: 0 };  // ฝั่งหน้าเว็บจะ fallback ไป fetch เองต่อ
      } finally { delete inflight[key]; }
    })();
  }
  return inflight[key].then(function (entry) { return Object.assign({ hit: false }, entry); });
}

/* ---------------- 2) ข้อมูลสด เขื่อน/ฝน (ตรรกะเดียวกับ live_status.js) ---------------- */
var DAM_URL = "https://api-v3.thaiwater.net/api/v1/thaiwater30/analyst/dam?dam_id=50";
var BANGLONG_CAP = 1420;                 // MCM ความจุเขื่อนบางลาง
var POLL_MS = 5 * 60 * 1000;             // poll ทุก 5 นาที (แชร์ทุกหน้า จึงยิงน้อยกว่าเดิม)
var lastLive = null;                     // { ok, data:{storage,released,inflow,rainfall}, ts }
var livePromise = null;
var pollTimer = null;

function timeoutSignal(ms) {
  try { return AbortSignal.timeout(ms); } catch (e) { return undefined; }
}

function parseBanglong(j) {
  if (!j || j.result !== "OK" || !j.data) return null;
  var hourly = Array.isArray(j.data.dam_hourly) ? j.data.dam_hourly : [];
  var entries = hourly.filter(function (e) {
    return e.dam_id === 50 || (e.name && String(e.name).toLowerCase().indexOf("banglang") >= 0);
  });
  var entry = entries.length ? entries[entries.length - 1] : (hourly.length ? hourly[0] : null);
  if (!entry) return null;
  var storageMcm = parseFloat(entry.dam_storage);
  var storagePct = parseFloat(entry.dam_storage_percent);
  if (isNaN(storagePct)) storagePct = isNaN(storageMcm) ? NaN : (storageMcm / BANGLONG_CAP * 100);
  var num = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; };   // 0 เป็นค่าจริง
  return { storage: isNaN(storagePct) ? null : storagePct, released: num(entry.dam_released), inflow: num(entry.dam_inflow) };
}

async function getDam() {
  var tiers = [
    DAM_URL,                                                             // 1. direct (API รองรับ CORS)
    "/api-thaiwater-v3/api/v1/thaiwater30/analyst/dam?dam_id=50",        // 2. vite dev proxy
    "https://api.allorigins.win/raw?url=" + encodeURIComponent(DAM_URL)  // 3. public CORS proxy
  ];
  for (var i = 0; i < tiers.length; i++) {
    try {
      var r = await fetch(tiers[i], { signal: timeoutSignal(9000) });
      if (r.ok) { var d = parseBanglong(await r.json()); if (d) return d; }
    } catch (e) { /* ลองชั้นถัดไป */ }
  }
  return null;
}

async function getRain() {
  try {
    var r = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=6.55&longitude=101.28" +
      "&current=precipitation,rain&timezone=Asia%2FBangkok&forecast_days=1",
      { signal: timeoutSignal(7000) });
    if (!r.ok) return null;
    var j = await r.json();
    return j && j.current ? (j.current.precipitation != null ? j.current.precipitation
      : (j.current.rain != null ? j.current.rain : null)) : null;
  } catch (e) { return null; }
}

function ensureLive(maxAgeMs) {
  if (lastLive && Date.now() - lastLive.ts < maxAgeMs) return Promise.resolve(lastLive);
  if (!livePromise) {
    livePromise = Promise.all([getDam(), getRain()]).then(function (res) {
      var dam = res[0], rain = res[1];
      var ok = !!dam || rain != null;
      var next = {
        ok: ok,
        data: ok ? { storage: dam ? dam.storage : null, released: dam ? dam.released : null,
                     inflow: dam ? dam.inflow : null, rainfall: rain } : null,
        ts: Date.now()
      };
      if (ok || !lastLive) lastLive = next;      // fetch พังแต่มีของเก่า → เก็บของเก่าไว้
      return lastLive;
    }).finally(function () { livePromise = null; });
  }
  return livePromise;
}

function broadcast(msg, except) {
  for (var i = ports.length - 1; i >= 0; i--) {
    if (ports[i] === except) continue;
    try { ports[i].postMessage(msg); } catch (e) { ports.splice(i, 1); }   // พอร์ตตายแล้ว → ตัดทิ้ง
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(function () {
    ensureLive(0).then(function (l) {
      if (l && l.ok) broadcast({ type: "live:update", ok: l.ok, data: l.data, ts: l.ts });
    });
  }, POLL_MS);
}

/* ---------------- การเชื่อมต่อจากแต่ละหน้า ---------------- */
onconnect = function (e) {
  var port = e.ports[0];
  ports.push(port);
  startPolling();

  port.onmessage = function (ev) {
    var m = ev.data || {};
    if (m.type === "data" && m.url) {
      loadData(m.url).then(function (entry) {
        try {
          port.postMessage({ type: "data", id: m.id, ok: entry.ok, status: entry.status,
                             bin: entry.bin, body: entry.body, hit: entry.hit });
        } catch (err) { /* พอร์ตปิดไปแล้ว */ }
      });
    } else if (m.type === "live") {
      ensureLive(m.maxAge != null ? m.maxAge : 120000).then(function (l) {
        try { port.postMessage({ type: "live", id: m.id, ok: l.ok, data: l.data, ts: l.ts }); } catch (err) {}
        if (l.ok) broadcast({ type: "live:update", ok: l.ok, data: l.data, ts: l.ts }, port);
      });
    } else if (m.type === "stats") {
      try {
        port.postMessage({ type: "stats", id: m.id, files: Object.keys(cache).length,
                           bytes: totalBytes, hits: stats.hits, misses: stats.misses,
                           revalidated: stats.revalidated, ports: ports.length });
      } catch (err) {}
    } else if (m.type === "bye") {                 // หน้าปิด/นำทางออก → ตัดพอร์ต
      var i = ports.indexOf(port);
      if (i >= 0) ports.splice(i, 1);
      try { port.close(); } catch (err) {}
    }
  };
  port.start && port.start();

  // หน้าใหม่เชื่อมเข้ามา → ส่งข้อมูลสดล่าสุดให้ทันที (ป้ายสถานะขึ้นไม่ต้องรอ fetch)
  if (lastLive && lastLive.ok) {
    try { port.postMessage({ type: "live:update", ok: lastLive.ok, data: lastLive.data, ts: lastLive.ts }); } catch (err) {}
  }
};
