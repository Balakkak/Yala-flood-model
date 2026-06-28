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
  var mode = "swipe";                 // 'before' | 'swipe' | 'after'
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
    var st = meta.STAGE, split = IVCompare.getSplit(), splitCol = split * NC;
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
    if (mode === "swipe") {                       // เส้นแบ่ง swipe
      var x = Math.round(splitCol);
      ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.fillRect(x - 1, 0, 2, NR);
    }
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

  // ================= สถิติ + ป้าย =================
  function updateStats() {
    var s = IVCompare.stats(); if (!s) return;
    $("cmpStats").style.display = "grid";
    $("stVolB").textContent = fmt(s.before.volume_m3); $("stVolA").textContent = fmt(s.after.volume_m3);
    $("stAreaB").textContent = fmt(s.before.area_rai); $("stAreaA").textContent = fmt(s.after.area_rai);
    $("stBldB").textContent = fmt(s.before.buildings); $("stBldA").textContent = fmt(s.after.buildings);
    var cut = function (el, before, red) { el.textContent = "−" + fmt(red) + (before > 0 ? " (" + Math.round(red / before * 100) + "%)" : ""); el.style.visibility = red > 0 ? "visible" : "hidden"; };
    cut($("stVolCut"), s.before.volume_m3, s.reduced.volume_m3);
    cut($("stAreaCut"), s.before.area_rai, s.reduced.area_rai);
    cut($("stBldCut"), s.before.buildings, s.reduced.buildings);
    // หมายเหตุสถานีสูบเมื่อเปิดคันกั้นที่ต้องสูบร่วม
    var pumps = IVCompare.levees().filter(function (l) { return IVCompare.isEnabled(l.rank) && l.needs_pump; });
    var pe = $("cmpPump");
    if (pumps.length) { pe.style.display = "block"; pe.innerHTML = '<i class="ti ti-windmill"></i> คันกั้นที่เปิด ' + pumps.length + ' จุด เป็นแบบล้อมพื้นที่ — ต้องมี<b>สถานีสูบระบายน้ำภายใน</b>ร่วมเสมอ'; }
    else { pe.style.display = "none"; }
  }

  function setMode(m) {
    mode = m;
    $("cmpBefore").classList.toggle("active", m === "before");
    $("cmpSwipe").classList.toggle("active", m === "swipe");
    $("cmpAfter").classList.toggle("active", m === "after");
    $("cmpSwipeWrap").style.opacity = m === "swipe" ? "1" : "0.4";
    $("cmpSplit").disabled = (m !== "swipe");
    if (m === "before") IVCompare.setSplit(1);
    else if (m === "after") IVCompare.setSplit(0);
    else IVCompare.setSplit($("cmpSplit").value / 100);
    syncSideLabels();
  }
  function syncSideLabels() {
    var split = IVCompare.getSplit();
    $("cmpSideB").style.display = split > 0.001 ? "block" : "none";
    $("cmpSideA").style.display = split < 0.999 ? "block" : "none";
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

    // controls
    $("cmpSplit").addEventListener("input", function () {
      if (mode !== "swipe") setMode("swipe");
      IVCompare.setSplit(this.value / 100);
    });
    $("cmpBefore").addEventListener("click", function () { setMode("before"); });
    $("cmpAfter").addEventListener("click", function () { setMode("after"); });
    $("cmpSwipe").addEventListener("click", function () { setMode("swipe"); });
    $("vw2d").addEventListener("click", function () { switchView("2d"); });
    $("vw3d").addEventListener("click", function () { switchView("3d"); });

    IVCompare.subscribe(function (kind) {
      if (view === "2d") draw2D();
      if (mount3dFn && IV3D.onUpdate) IV3D.onUpdate(kind);
      if (kind === "after") { styleLevees(); updateStats(); }
      if (kind === "split") syncSideLabels();
    });
    setMode("swipe");
  }

  // ================= สลับมุมมอง 2D/3D =================
  function switchView(v) {
    if (v === view) return; view = v;
    $("vw2d").classList.toggle("active", v === "2d");
    $("vw3d").classList.toggle("active", v === "3d");
    var d3 = $("map3d"), m2 = $("map");
    if (v === "3d") {
      d3.style.display = "block";
      if (m2) m2.style.visibility = "hidden";       // กัน Leaflet โผล่ทะลุ canvas 3D
      if (!mount3dFn) { mount3dFn = true; IV3D.mount(d3, meta); }
      else IV3D.show && IV3D.show();
    } else {
      d3.style.display = "none";
      if (m2) m2.style.visibility = "visible";
      IV3D.hide && IV3D.hide();
      draw2D();
    }
  }

  return { mount: mount, redraw2D: draw2D, getMode: function () { return mode; }, getView: function () { return view; } };
})();

// IV3D ถูกนิยามใน intervention_3d.js (Stage 3) — กันพังถ้ายังไม่โหลด
window.IV3D = window.IV3D || { mount: function (el) { el.innerHTML = '<div style="position:absolute;inset:0;display:grid;place-items:center;color:#64748b;font:600 13px Sarabun,sans-serif;background:#f8fafc;">กำลังเตรียมมุมมอง 3D…</div>'; }, onUpdate: function () {}, show: function () {}, hide: function () {} };
