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
        '<div><div class="t"><i class="ti ti-shield-half" style="color:#78716c;"></i> ' + lv.label + '</div>' +
        '<div class="d">ป้องกัน ~' + lv.protected + ' หลัง · ~' + (lv.cost_thb / 1e6).toFixed(0) + ' ล้าน฿' +
        (lv.length_m ? ' · ยาว ~' + (lv.length_m / 1000).toFixed(1) + ' กม.' : '') +
        (lv.needs_pump ? ' · ต้องมีประตูระบาย/สูบ' : '') +
        '<br><span style="color:#047857;">วางริมตลิ่งฝั่งเมือง · เลี่ยงรอยอาคาร (ทับ ' + (lv.bld_under_wall || 0) + ' หลัง)</span>' +
        (lv.gates != null ? '<br><span style="color:#6d28d9;"><i class="ti ti-door"></i> ต้องมีประตูระบาย/สูบ ' + lv.gates + ' จุด (ตัดถนน)</span>' : '') +
        (lv.newly_flooded != null ? '<br><span style="color:#b45309;"><i class="ti ti-scale"></i> No-Adverse-Impact: อาคารกระทบเพิ่ม ' + lv.newly_flooded + ' — ต้องยืนยัน HEC-RAS 2D</span>' : '') +
        '</div></div>';
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

  // โฟกัสไปจุดหนึ่ง (3D บินไป / 2D pan) — ใช้กับรายการมาตรการเชิงข้อมูล
  function focusPoint(lng, lat) {
    if (view === "3d" && IV3D.flyTo) IV3D.flyTo(lng, lat);
    else if (lmap) lmap.flyTo([lat, lng], 15, { animate: true });
  }

  // ================= มาตรการเชิงข้อมูล (คอขวด/แก้มลิง) — ยังไม่จำลองผล รอ SWMM =================
  function buildInfoMeasures() {
    var host = $("structToggles");
    fetch("data/intervention_candidates.geojson").then(function (r) { return r.json(); }).then(function (fc) {
      var pts = (fc.features || []).filter(function (f) {
        return f.geometry && f.geometry.type === "Point" && (f.properties.kind === "bottleneck" || f.properties.kind === "retention");
      });
      if (!pts.length) return;
      var wrap = document.createElement("div");
      wrap.innerHTML = '<div class="info-divider"><i class="ti ti-flask"></i> มาตรการเสริม · กดเพื่อดูตำแหน่งบนแผนที่ — ยังไม่จำลองผลลดน้ำท่วม (รอ SWMM)</div>';
      // แก้มลิงก่อน แล้วคอขวด (ให้ตรงลำดับในรายการแนะนำ)
      pts.sort(function (a, b) { return (a.properties.kind === "retention" ? 0 : 1) - (b.properties.kind === "retention" ? 0 : 1); });
      pts.forEach(function (f) {
        var p = f.properties, isPond = p.kind === "retention";
        var lng = f.geometry.coordinates[0], lat = f.geometry.coordinates[1];
        var icon = isPond ? "ti-droplet" : "ti-windmill", col = isPond ? "#0f766e" : "#c2410c";
        var detail;
        if (isPond) {
          var land = (p.buildings_on_site === 0 && (p.road_on_site || 0) === 0) ? " · ที่ว่าง ไม่ทับอาคาร/ถนน"
            : (p.buildings_on_site === 0 ? " · เลี่ยงอาคารแล้ว" + ((p.road_on_site || 0) > 0 ? " (มีถนนพาด)" : "")
            : (p.buildings_on_site != null ? " · มีอาคาร ~" + p.buildings_on_site + " หลัง" : ""));
          detail = "บ่อหน่วง ~" + (p.area_rai || "?") + " ไร่ · เก็บ ~" + ((p.storage_m3 || 0).toLocaleString()) + " ลบ.ม." + land;
        } else {
          var spot = p.relocated ? " · ขยับเลี่ยงอาคารแล้ว" : (p.on_road ? " · ตั้งริมถนนได้" : "");
          detail = "ความจุระบายปัจจุบัน " + (p.drain_cm != null ? p.drain_cm + " ซม." : "ต่ำ") + " · ควรเพิ่มท่อ/สูบ" + spot;
        }
        var row = document.createElement("div");
        row.className = "struct-info";
        row.innerHTML = '<i class="ti ' + icon + '" style="color:' + col + ';margin-top:1px;"></i>'
          + '<div style="flex:1;"><div class="t" style="font-size:12px;font-weight:700;color:var(--ink-900);">' + esc(p.label)
          + ' <span class="info-badge">เชิงข้อมูล</span></div>'
          + '<div class="d" style="font-size:10.5px;color:var(--ink-600);margin-top:2px;line-height:1.45;">' + esc(detail) + '</div></div>'
          + '<i class="ti ti-map-pin" style="color:var(--ink-400);margin-top:1px;"></i>';
        row.addEventListener("click", function () { focusPoint(lng, lat); });
        wrap.appendChild(row);
      });
      host.appendChild(wrap);
    }).catch(function (e) { console.warn("info measures โหลดไม่ได้", e); });
  }

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
    buildInfoMeasures();
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
      try { localStorage.setItem("yalaSim", JSON.stringify({ rain: rain, river: river, dam: dam })); } catch (e) {}   // แชร์ระดับน้ำกับหน้าจำลอง
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

    // ดึงระดับน้ำที่ "จำลองไว้ในหน้าจำลองน้ำท่วม" (yalaSim) มาตั้งเป็นค่าเริ่มต้น
    (function restoreFromSim() {
      var s = null; try { s = JSON.parse(localStorage.getItem("yalaSim") || "null"); } catch (e) {}
      if (!s) return;
      if (s.rain != null) $("sRain").value = s.rain;
      if (s.river != null) $("sRiver").value = s.river;
      if (s.dam != null) $("sDam").value = s.dam;
      var note = $("simNote"); if (note) note.style.display = "flex";
    })();
    applyLevel();                      // ตั้งระดับน้ำเริ่มต้น (จากระดับที่จำลองไว้ ถ้ามี)
    updateLevelReadout();
    // มุมมองเริ่มต้นตาม ?v= (มาจากปุ่มหน้าต่างบนแถบนำทาง) — ค่าเริ่มต้น 3D
    var v0 = (new URLSearchParams(location.search).get("v") === "2d") ? "2d" : "3d";
    if (v0 === "3d") switchView("3d");
    else { $("vw2d").classList.add("active"); syncNav("2d"); }
  }

  // ซิงก์ปุ่ม 2D/3D ของกลุ่ม "แก้โครงสร้าง" บนแถบนำทางกับมุมมองปัจจุบัน
  function syncNav(v) {
    var a2 = document.getElementById("navIv2d"), a3 = document.getElementById("navIv3d");
    if (a2) a2.classList.toggle("active", v === "2d");
    if (a3) a3.classList.toggle("active", v === "3d");
  }

  // ================= สลับมุมมอง 2D/3D =================
  var fellBack3d = false;
  function switchView(v) {
    if (v === view) return; view = v;
    $("vw2d").classList.toggle("active", v === "2d");
    $("vw3d").classList.toggle("active", v === "3d");
    syncNav(v);
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
window.IV3D = window.IV3D || { mount: function (el, _meta, onFail) { if (onFail) setTimeout(onFail, 50); }, onUpdate: function () {}, setFlow: function () {}, flyTo: function () {}, show: function () {}, hide: function () {} };
