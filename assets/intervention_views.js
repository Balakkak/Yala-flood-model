/* ============================================================================
 * intervention_views.js — UI/renderer ของเครื่องเปรียบเทียบ ก่อน–หลังสร้าง
 * ----------------------------------------------------------------------------
 * ทำงานคู่กับ IVCompare (engine) :
 *   - 2D : วาด depth grid ลง canvas → L.imageOverlay บนแผนที่ Leaflet (มี dried = เขียว)
 *   - 3D : MapLibre custom WebGL water (เติมใน mount3D — Stage 3)
 *   - swipe เดียวคุมทั้งสองมุมมอง (split 0..1) + ปุ่ม ก่อน/เทียบ/หลัง
 *   - คุมมาตรการ (toggle คันกั้นแต่ละจุด) + แสดงสถิติ ก่อน→หลัง + ลดลง
 * ========================================================================== */
window.IVViews = (function () {
  "use strict";
  var L, lmap, meta, NC, NR;
  var canvas, ctx, floodOverlay, leveeLayers = {};
  var mount3dFn = null, view = "2d";

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(n).toLocaleString(); };

  // ---- สีตามความลึก (0→3 ม.) : ฟ้าอ่อน → ฟ้า → กรมท่า ----
  function lerp(a, b, t) { return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]; }
  var C0 = [186, 230, 253], C1 = [56, 189, 248], C2 = [12, 74, 110];
  function depthColor(d) {
    var t = Math.max(0, Math.min(1, d / 3));
    return t < 0.5 ? lerp(C0, C1, t / 0.5) : lerp(C1, C2, (t - 0.5) / 0.5);
  }

  // ================= 2D =================
  function draw2D() {
    if (!ctx) return;
    var A = IVCompare.arrivals(), base = A.base, after = A.after;
    var ar = IVCompare.arrays(), inStudy = ar.inStudy, chan = ar.chanMask;
    var st = IVCompare.getStage(), split = IVCompare.getSplit(), splitCol = split * NC;
    var img = ctx.createImageData(NC, NR), d = img.data;
    for (var r = 0; r < NR; r++) for (var c = 0; c < NC; c++) {
      var i = r * NC + c, o = i * 4;
      if (!inStudy[i] || chan[i]) { d[o + 3] = 0; continue; }
      var useBefore = c < splitCol;
      var arr = useBefore ? base[i] : after[i];
      if (arr <= st) {
        var col = depthColor(st - arr);
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 205;
      } else if (!useBefore && base[i] <= st) {
        d[o] = 52; d[o + 1] = 211; d[o + 2] = 153; d[o + 3] = 150;   // dried = เขียว
      } else { d[o + 3] = 0; }
    }
    ctx.putImageData(img, 0, 0);
    floodOverlay.setUrl(canvas.toDataURL());
  }

  function styleLevees() {
    IVCompare.levees().forEach(function (lv) {
      var lay = leveeLayers[lv.rank]; if (!lay) return;
      var on = IVCompare.isEnabled(lv.rank);
      lay.setStyle({ color: "#2563eb", weight: on ? 3 : 1.5, opacity: on ? 1 : 0.55,
        fillColor: "#3b82f6", fillOpacity: on ? 0.18 : 0, dashArray: on ? null : "5,5" });
    });
  }

  // ================= ผลของมาตรการ (ป้องกันได้เท่าไร เมื่อเทียบกับไม่มีโครงสร้าง) =================
  function updateStats() {
    var s = IVCompare.stats(); if (!s) return;
    var n = IVCompare.enabledCount(), res = $("protResult");
    res.style.display = "block";
    if (n === 0) {
      res.className = "prot-result none";
      res.innerHTML = '<i class="ti ti-info-circle"></i> ยังไม่เปิดมาตรการ — น้ำท่วมเต็มตามระดับที่จำลอง';
    } else {
      res.className = "prot-result";
      res.innerHTML = '<i class="ti ti-shield-check"></i> เปิด ' + n + ' มาตรการ · ป้องกันอาคาร <b>~' +
        fmt(s.reduced.buildings) + ' หลัง</b> · ลดปริมาตรน้ำ <b>~' + s.reduced.volume_pct + '%</b> (ที่ระดับน้ำปัจจุบัน)';
    }
    // หมายเหตุสถานีสูบเมื่อเปิดคันกั้นที่ต้องสูบร่วม
    var pumps = IVCompare.levees().filter(function (l) { return IVCompare.isEnabled(l.rank) && l.needs_pump; });
    var pe = $("cmpPump");
    if (pumps.length) { pe.style.display = "block"; pe.innerHTML = '<i class="ti ti-windmill"></i> คันกั้นที่เปิด ' + pumps.length + ' จุด เป็นแบบล้อมพื้นที่ — ต้องมี<b>สถานีสูบระบายน้ำภายใน</b>ร่วมเสมอ'; }
    else { pe.style.display = "none"; }
  }

  // ================= โครงสร้าง toggles =================
  function buildToggles() {
    var host = $("structToggles"); host.innerHTML = "";
    IVCompare.levees().forEach(function (lv) {
      var el = document.createElement("label");
      el.className = "struct-tog";
      el.innerHTML =
        '<input type="checkbox" data-rank="' + lv.rank + '">' +
        '<div><div class="t"><i class="ti ti-shield-half" style="color:#2563eb;"></i> ' + lv.label + '</div>' +
        '<div class="d">ป้องกัน ~' + lv.protected + ' หลัง · ~' + (lv.cost_thb / 1e6).toFixed(1) + ' ล้าน฿' +
        (lv.needs_pump ? ' · ต้องมีสถานีสูบ' : '') + '</div></div>';
      var cb = el.querySelector("input");
      cb.addEventListener("change", function () {
        el.classList.toggle("on", cb.checked);
        IVCompare.toggle(lv.rank, cb.checked);
        if (view === "2d" && lmap) lmap.panInsideBounds && fitToActive();
      });
      host.appendChild(el);
    });
  }
  function fitToActive() { /* คงมุมมองเดิม — ไม่บังคับซูม */ }

  // ================= mount =================
  function mount(leaflet_map, Lref) {
    L = Lref; lmap = leaflet_map; meta = IVCompare.meta(); NC = meta.NC; NR = meta.NR;
    $("sStage") && ($("sStage").textContent = meta.DESIGN_S);

    canvas = document.createElement("canvas"); canvas.width = NC; canvas.height = NR;
    ctx = canvas.getContext("2d");
    floodOverlay = L.imageOverlay("", IVCompare.boundsLatLng(),
      { opacity: 0.8, interactive: false, className: "iv-flood", pane: "overlayPane" }).addTo(lmap);

    // โพลิกอนคันกั้น (เน้นเมื่อเปิด)
    IVCompare.levees().forEach(function (lv) {
      if (!lv.polygon || lv.polygon.length < 3) return;
      var latlng = lv.polygon.map(function (p) { return [p[1], p[0]]; });
      leveeLayers[lv.rank] = L.polygon(latlng, {}).addTo(lmap)
        .bindPopup("<b>" + lv.label + "</b><br>ป้องกัน ~" + lv.protected + " หลัง" + (lv.needs_pump ? "<br><span style='color:#b45309'>* ต้องมีสถานีสูบร่วม</span>" : ""));
    });
    styleLevees();

    buildToggles();
    updateStats();
    draw2D();

    // controls — โชว์สถานะ "มีโครงสร้าง" เสมอ (เอา UI เปรียบเทียบ ก่อน/หลัง ออก แต่เก็บโค้ดไว้)
    IVCompare.setSplit(0);
    $("vw2d").addEventListener("click", function () { switchView("2d"); });
    $("vw3d").addEventListener("click", function () { switchView("3d"); });

    // ---- ระดับน้ำ (ฝน/แม่น้ำ/เขื่อน) ----
    function applyLevel() {
      var rain = +$("sRain").value, river = +$("sRiver").value, dam = +$("sDam").value;
      $("vRain").textContent = rain; $("vRiver").textContent = river; $("vDam").textContent = dam;
      IVCompare.setStage(IVCompare.stageFromInputs(rain, river, dam));
    }
    function updateLevelReadout() {
      var s = IVCompare.getStage(), rg = IVCompare.stageRange(), tag = $("lvlTag");
      $("lvlStage").textContent = s.toFixed(2);
      if (s >= rg.design - 0.05) { tag.textContent = "เหตุการณ์ออกแบบ"; tag.className = "lvl-tag design"; }
      else if (s >= rg.onset) { tag.textContent = "เริ่มท่วม"; tag.className = "lvl-tag onset"; }
      else { tag.textContent = "ปกติ"; tag.className = "lvl-tag calm"; }
    }

    IVCompare.subscribe(function (kind) {
      if (view === "2d") draw2D();
      if (mount3dFn && IV3D.onUpdate) IV3D.onUpdate(kind);
      if (kind === "after") { styleLevees(); updateStats(); }
      if (kind === "stage") { updateStats(); updateLevelReadout(); }
    });

    // ---- อนิเมชัน "จำลองการท่วม": ไล่ระดับน้ำจากแห้ง → เป้าหมาย (น้ำแพร่ตามลำดับการท่วม) ----
    var playTimer = null, PLAY_MS = 7000;
    function targetStage() { return IVCompare.stageFromInputs(+$("sRain").value, +$("sRiver").value, +$("sDam").value); }
    function setPlayBtn(on) {
      $("btnPlayFlood").classList.toggle("playing", on);
      $("playIcon").className = on ? "ti ti-player-stop-filled" : "ti ti-player-play-filled";
      $("playLabel").textContent = on ? "หยุด" : "จำลองการท่วม";
    }
    function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; } setPlayBtn(false); }
    function playFlood() {
      if (playTimer) { stopPlay(); IVCompare.setStage(targetStage()); return; }
      var rg = IVCompare.stageRange(), from = rg.min, to = targetStage();
      if (to <= from + 0.01) return;
      var t0 = performance.now();
      setPlayBtn(true);
      playTimer = setInterval(function () {            // setInterval ทำงานแม้แท็บไม่โฟกัส (rAF ถูกพัก)
        var k = Math.min(1, (performance.now() - t0) / PLAY_MS);
        IVCompare.setStage(from + (to - from) * (k * k * (3 - 2 * k)));   // ease-in-out
        if (k >= 1) { clearInterval(playTimer); playTimer = null; setPlayBtn(false); }
      }, 33);
    }

    ["sRain", "sRiver", "sDam"].forEach(function (id) { $(id).addEventListener("input", function () { stopPlay(); applyLevel(); }); });
    $("btnDesignEvent").addEventListener("click", function () { stopPlay(); $("sRain").value = 40; $("sRiver").value = 100; $("sDam").value = 100; applyLevel(); });
    $("btnPlayFlood").addEventListener("click", playFlood);
    $("togFlow").addEventListener("change", function () { if (IV3D.setFlow) IV3D.setFlow(this.checked); });

    // ---- ดึงค่าจริง (เขื่อน/ฝน) เหมือนหน้า 3D ----
    var bLive = $("btnLive"), liveStatus = $("liveStatus");
    if (bLive) bLive.addEventListener("click", function () {
      bLive.disabled = true; bLive.innerHTML = '<i class="ti ti-loader"></i> กำลังดึง...';
      Promise.resolve(window.YalaLive ? YalaLive.fetchLive() : { data: null }).then(function (rep) {
        var dam = rep && rep.data ? rep.data.storage : null, rain = rep && rep.data ? rep.data.rainfall : null;
        if (dam != null) $("sDam").value = Math.round(dam);
        if (rain != null) $("sRain").value = Math.min(100, Math.max(0, Math.round(rain)));
        stopPlay(); applyLevel();
        liveStatus.innerHTML = (dam != null || rain != null)
          ? 'ค่าจริง · เขื่อน ' + (dam != null ? dam.toFixed(0) + '%' : '–') + ' · ฝน ' + (rain != null ? rain.toFixed(1) + ' mm/hr' : '–') + ' → กด "จำลองการท่วม"'
          : 'ดึงค่าจริงไม่ได้ — ปรับสไลเดอร์เองได้';
      }).catch(function () { liveStatus.textContent = 'ดึงค่าจริงไม่ได้ — ปรับสไลเดอร์เองได้'; })
        .then(function () { bLive.disabled = false; bLive.innerHTML = '<i class="ti ti-rss"></i> ดึงค่าปัจจุบันจริง'; });
    });

    applyLevel();                      // ตั้งระดับน้ำเริ่มต้นจากสไลเดอร์
    switchView("3d");                  // มุมมองหลัก = 3D
  }

  // ================= สลับมุมมอง 2D/3D =================
  var fellBack3d = false;
  function switchView(v) {
    if (v === view) return; view = v;
    $("vw2d").classList.toggle("active", v === "2d");
    $("vw3d").classList.toggle("active", v === "3d");
    var d3 = $("map3d"), m2 = $("map");
    if (v === "3d") {
      d3.style.display = "block";
      if (m2) m2.style.visibility = "hidden";       // กัน Leaflet โผล่ทะลุ canvas 3D
      if (!mount3dFn) { mount3dFn = true; IV3D.mount(d3, meta, on3dUnavailable); }
      else IV3D.show && IV3D.show();
    } else {
      d3.style.display = "none";
      if (m2) m2.style.visibility = "visible";
      IV3D.hide && IV3D.hide();
      draw2D();
    }
  }
  // ถ้า 3D เรนเดอร์ไม่ได้ (ไม่มี WebGL2) → กลับมา 2D อัตโนมัติ
  function on3dUnavailable() {
    if (fellBack3d) return; fellBack3d = true;
    if (view === "3d") switchView("2d");
    var ls = $("liveStatus"); if (ls) { /* no-op */ }
    var b = $("vw3d"); if (b) b.title = "มุมมอง 3D ต้องใช้ WebGL2 (เบราว์เซอร์นี้ไม่รองรับ) — กำลังแสดง 2D";
  }

  return { mount: mount, redraw2D: draw2D, getView: function () { return view; } };
})();

// IV3D ถูกนิยามใน intervention_3d.js (Stage 3) — กันพังถ้ายังไม่โหลด
window.IV3D = window.IV3D || { mount: function (el, _meta, onFail) { if (onFail) setTimeout(onFail, 50); }, onUpdate: function () {}, setFlow: function () {}, show: function () {}, hide: function () {} };
