/* ============================================================================
 * live_status.js  —  สถานะการเชื่อมต่อข้อมูลสด + แคช last-known-good
 * ----------------------------------------------------------------------------
 * ใช้ร่วมกันทั้งหน้า 2D (dashboard.html) และ 3D (index.html)
 *
 * แก้จุดอ่อน 2 อย่าง:
 *   1) ป้าย "ระบบออนไลน์" บน header เดิมเป็นค่าตายตัว ไม่สะท้อนว่าดึง API จริงสำเร็จไหม
 *      → ตอนนี้สลับสถานะตามผลจริง: ออนไลน์ / ใช้ข้อมูลแคช / ออฟไลน์
 *   2) ถ้า ThaiWater/Open-Meteo ล่มตอนเดโม จะไม่มีข้อมูลเลย
 *      → เก็บค่าล่าสุดที่ดึงสำเร็จไว้ใน localStorage (last-known-good)
 *        พอ fetch พังก็ดึงค่าที่แคชไว้มาแสดงแทน พร้อมบอกเวลาที่อัปเดตล่าสุด
 *
 * cache shape (localStorage["yalaLiveCache"]):
 *   { ts: <epoch ms>, data: { storage, released, inflow, rainfall } }
 * ========================================================================== */
(function () {
  "use strict";

  var CACHE_KEY = "yalaLiveCache";
  var pill = document.querySelector(".status-pill");
  var txt = document.getElementById("statusText");

  function setStatus(state, label) {
    if (pill) {
      pill.classList.remove("is-online", "is-cached", "is-offline", "is-connecting");
      pill.classList.add("is-" + state);
    }
    if (txt && label != null) txt.textContent = label;
  }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  function cacheSave(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) {}
  }

  // คืน { ts, data } ถ้ามีและไม่เก่าเกิน maxAgeMs (ไม่ใส่ = ไม่จำกัดอายุ)
  function cacheLoad(maxAgeMs) {
    try {
      var s = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!s || !s.data) return null;
      if (maxAgeMs && Date.now() - s.ts > maxAgeMs) return null;
      return s;
    } catch (e) { return null; }
  }

  /* เรียกหลังจบ fetch — ตัดสินสถานะ pill + จัดการแคชให้อัตโนมัติ
   *   ok=true  → ออนไลน์ + เซฟแคช         → { source:"live",  data }
   *   ok=false → ลองโหลดแคช (ถ้ามี)        → { source:"cache", data, ts }
   *              ถ้าไม่มีแคช                → { source:"none",  data:null }
   */
  function report(ok, liveData) {
    if (ok && liveData) {
      cacheSave(liveData);
      setStatus("online", "ข้อมูลสด · " + fmtTime(Date.now()));
      return { source: "live", data: liveData, ts: Date.now() };
    }
    var c = cacheLoad();
    if (c) {
      setStatus("cached", "ข้อมูลล่าสุด " + fmtTime(c.ts));
      return { source: "cache", data: c.data, ts: c.ts };
    }
    setStatus("offline", "ออฟไลน์");
    return { source: "none", data: null };
  }

  /* ----- ตัวดึงข้อมูลสดกลาง (ใช้ร่วมทั้ง 2D/3D — รวม fallback หลายชั้นไว้ที่เดียว) ----- */
  var DAM_URL = "https://api-v3.thaiwater.net/api/v1/thaiwater30/analyst/dam?dam_id=50";
  var BANGLONG_CAP = 1420; // MCM ความจุเขื่อนบางลาง

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
    var num = function (v) { var n = parseFloat(v); return isNaN(n) ? null : n; }; // 0 เป็นค่าจริง ไม่ใช่ "ไม่มีข้อมูล"
    return {
      storage: isNaN(storagePct) ? null : storagePct,
      released: num(entry.dam_released),
      inflow: num(entry.dam_inflow)
    };
  }

  async function getDam() {
    var tiers = [
      DAM_URL,                                                            // 1. direct
      "/api-thaiwater-v3/api/v1/thaiwater30/analyst/dam?dam_id=50",       // 2. vite proxy
      "https://api.allorigins.win/raw?url=" + encodeURIComponent(DAM_URL) // 3. public CORS proxy
    ];
    for (var i = 0; i < tiers.length; i++) {
      try {
        var r = await fetch(tiers[i], { signal: AbortSignal.timeout(9000) });
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
        { signal: AbortSignal.timeout(7000) }
      );
      if (!r.ok) return null;
      var j = await r.json();
      return j && j.current ? (j.current.precipitation != null ? j.current.precipitation
        : (j.current.rain != null ? j.current.rain : null)) : null;
    } catch (e) { return null; }
  }

  // ดึงเขื่อน+ฝนพร้อมกัน → เซฟแคช + ตั้งป้ายสถานะ อัตโนมัติ
  // คืน { source:"live"|"cache"|"none", data:{storage,released,inflow,rainfall}|null, ts }
  // ถ้ามี SharedWorker กลาง (shared_data.js) → ใช้ข้อมูลสดชุดเดียวร่วมกันทุกหน้า/แท็บ
  // (worker เป็นคน fetch — หน้าไหนขอก่อนหน้าอื่นได้ใช้ด้วย) · ไม่มี/พัง → ดึงเองแบบเดิม
  async function fetchLive() {
    if (window.YalaShared && YalaShared.active) {
      try {
        var m = await YalaShared.getLive(120000);
        if (m && m.ok && m.data) return report(true, m.data);
      } catch (e) { /* worker ใช้ไม่ได้ → ดึงเองต่อ */ }
    }
    var res = await Promise.all([getDam(), getRain()]);
    var dam = res[0], rain = res[1];
    var ok = !!dam || rain != null;
    var live = ok ? {
      storage: dam ? dam.storage : null,
      released: dam ? dam.released : null,
      inflow: dam ? dam.inflow : null,
      rainfall: rain
    } : null;
    return report(ok, live);
  }

  // สถานะเริ่มต้น: ถ้ามีแคชเดิมอยู่ โชว์เป็น cached ไปก่อน ระหว่างรอ fetch รอบใหม่
  var init = cacheLoad();
  if (init) setStatus("cached", "ข้อมูลล่าสุด " + fmtTime(init.ts));
  else setStatus("connecting", "กำลังเชื่อมต่อ…");

  // worker poll รอบใหม่สำเร็จ (หรือเพิ่งเชื่อมต่อแล้ว worker มีข้อมูลอยู่แล้ว) → อัปเดตป้าย+แคชทันที
  if (window.YalaShared) YalaShared.onLive(function (m) {
    if (m && m.ok && m.data) report(true, m.data);
  });

  window.YalaLive = {
    setStatus: setStatus,
    fmtTime: fmtTime,
    cacheSave: cacheSave,
    cacheLoad: cacheLoad,
    report: report,
    fetchLive: fetchLive,
    CACHE_KEY: CACHE_KEY
  };
})();
