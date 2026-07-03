/* ============================================================================
 * shared_data.js — ฝั่งหน้าเว็บของ SharedWorker กลาง (assets/shared_worker.js)
 * ----------------------------------------------------------------------------
 * โหลดเป็นสคริปต์แรก ๆ ของทุกหน้า (ก่อนสคริปต์ที่ fetch ข้อมูล) แล้วทำ 2 อย่าง:
 *
 *   1) ครอบ window.fetch — คำขอ GET ไฟล์ data/*.json|geojson|tif ถูกส่งไปให้
 *      SharedWorker โหลด/แคชแทน (โหลดจริงครั้งเดียวต่อเซสชัน ใช้ร่วมทุกหน้า/แท็บ)
 *      โค้ดเดิมไม่ต้องแก้สักบรรทัด — ได้ Response กลับเหมือน fetch ปกติ
 *   2) เปิด API window.YalaShared = { active, getLive, onLive, stats }
 *      ให้ live_status.js ใช้ข้อมูลสดชุดเดียวร่วมกันทุกหน้า
 *
 * ถ้าเบราว์เซอร์ไม่มี SharedWorker (เช่น Chrome บน Android) หรือ worker พัง
 * → ไม่แตะ fetch เลย ทุกอย่างทำงานแบบเดิม (graceful fallback)
 * ========================================================================== */
(function () {
  "use strict";

  var port = null, seq = 0, pending = {};   // id → {resolve, reject, timer}
  var liveCbs = [];

  function disable() {                       // worker ใช้ไม่ได้ → ปลด patch ทั้งหมด
    if (window.fetch === patchedFetch) window.fetch = natFetch;
    var p = port; port = null;
    if (p) { try { p.close(); } catch (e) {} }
    Object.keys(pending).forEach(function (id) {
      clearTimeout(pending[id].timer);
      pending[id].reject(new Error("shared worker disabled"));
      delete pending[id];
    });
  }

  try {
    var worker = new SharedWorker("assets/shared_worker.js", "yala-shared");
    port = worker.port;
    worker.onerror = disable;
    port.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.id && pending[m.id]) {
        clearTimeout(pending[m.id].timer);
        pending[m.id].resolve(m);
        delete pending[m.id];
      } else if (m.type === "live:update") {
        liveCbs.forEach(function (cb) { try { cb(m); } catch (e) {} });
      }
    };
    port.start();
    window.addEventListener("pagehide", function () {
      if (port) { try { port.postMessage({ type: "bye" }); } catch (e) {} }
    });
  } catch (e) { port = null; }

  // ส่งคำขอไป worker → Promise ของคำตอบ (เกินเวลา = reject → ผู้เรียก fallback เอง)
  function ask(msg, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!port) return reject(new Error("no shared worker"));
      var id = ++seq;
      msg.id = id;
      pending[id] = {
        resolve: resolve, reject: reject,
        timer: setTimeout(function () {
          delete pending[id];
          reject(new Error("shared worker timeout"));
        }, timeoutMs || 20000)
      };
      try { port.postMessage(msg); } catch (e) {
        clearTimeout(pending[id].timer); delete pending[id];
        disable(); reject(e);
      }
    });
  }

  /* ---------- 1) ครอบ fetch สำหรับไฟล์ข้อมูล ---------- */
  var natFetch = window.fetch.bind(window);

  function dataUrlOf(input, init) {
    try {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (method !== "GET" || !url) return null;
      var u = new URL(url, location.href);
      if (u.origin !== location.origin) return null;
      if (!/\/data\/[^/]+\.(?:json|geojson|tif)$/i.test(u.pathname)) return null;
      return u.href;                        // ส่ง URL สัมบูรณ์ — worker resolve จาก assets/ เองไม่ได้
    } catch (e) { return null; }
  }

  function patchedFetch(input, init) {
    var href = port ? dataUrlOf(input, init) : null;
    if (!href) return natFetch(input, init);
    return ask({ type: "data", url: href }, 30000).then(function (m) {
      if (!m.ok || !m.status) throw new Error("worker fetch failed: " + m.status);
      return new Response(m.body, {
        status: m.status,
        headers: { "Content-Type": m.bin ? "application/octet-stream" : "application/json" }
      });
    }).catch(function () { return natFetch(input, init); });   // worker พัง/ช้า → โหลดตรงเอง
  }
  if (port) window.fetch = patchedFetch;

  /* ---------- 2) API ข้อมูลสดร่วม ---------- */
  window.YalaShared = {
    get active() { return !!port; },
    // ขอข้อมูลสดจาก worker (สดไม่เกิน maxAge ms — ค่าปริยาย 2 นาที) → {ok,data,ts}
    getLive: function (maxAge) { return ask({ type: "live", maxAge: maxAge }, 30000); },
    // สมัครรับ broadcast เมื่อ worker ได้ข้อมูลสดรอบใหม่ (รวมตอนเพิ่งเชื่อมต่อ)
    onLive: function (cb) { if (typeof cb === "function") liveCbs.push(cb); },
    stats: function () { return ask({ type: "stats" }, 5000); }
  };
})();
