/* ============================================================================
 * lisflood_viewer.js
 * ----------------------------------------------------------------------------
 * โหมด viewer สำหรับผลจำลอง LISFLOOD-FP (2D hydrodynamic จริง)
 * โหลด lisflood/frames/manifest.json + เฟรม PNG ความลึกน้ำราย-เวลา
 * แล้วแสดงเป็นเลเยอร์ภาพเคลื่อนไหวบนแผนที่ + แผงควบคุมของตัวเอง
 *
 * แยกจาก flood_analysis.js โดยสมบูรณ์ — ถ้ายังไม่ได้รันโมเดล (ไม่มี manifest)
 * สคริปต์นี้จะเงียบ ไม่กระทบแดชบอร์ดเดิม
 * ========================================================================== */
(function () {
  "use strict";
  if (typeof map === "undefined" || typeof L === "undefined") return;

  var MANIFEST = "lisflood/frames/manifest.json";

  fetch(MANIFEST)
    .then(function (r) { if (!r.ok) throw new Error("no manifest"); return r.json(); })
    .then(function (m) { init(m); })
    .catch(function () { /* ยังไม่ได้รันโมเดล — ไม่ทำอะไร */ });

  function init(m) {
    if (!m.frames || !m.frames.length) return;
    var b = m.bbox;
    var bounds = [[b.lat_min, b.lon_min], [b.lat_max, b.lon_max]];
    var base = "lisflood/frames/";

    // preload เฟรม
    m.frames.forEach(function (f) { var i = new Image(); i.src = base + f.file; });

    var overlay = L.imageOverlay(base + m.frames[0].file, bounds, {
      opacity: 0.7, interactive: false, className: "lisflood-frame"
    });
    var group = L.layerGroup([overlay]);
    if (typeof layerControl !== "undefined")
      layerControl.addOverlay(group, "ผลจำลอง LISFLOOD-FP 2D (hydrodynamic)");

    // --- แผงควบคุม (สร้างเอง) ---
    var panel = document.createElement("div");
    panel.className = "lf-panel";
    panel.style.display = "none";
    panel.innerHTML =
      '<div class="lf-head"><i class="ti ti-wave-saw-tool"></i> LISFLOOD-FP · 2D Hydrodynamic' +
      '<span class="lf-sub">' + (m.model || "") + '</span></div>' +
      '<div class="lf-row">' +
        '<button class="lf-play" id="lfPlay"><i class="ti ti-player-play"></i></button>' +
        '<input type="range" class="lf-slider" id="lfSld" min="0" max="' + (m.frames.length - 1) + '" value="0" step="1">' +
        '<span class="lf-time" id="lfTime">0 ชม.</span>' +
      '</div>' +
      '<div class="lf-stats">' +
        '<span>พื้นที่ท่วม <b id="lfPct">0</b>%</span>' +
        '<span>ความลึก P95 <b id="lfDepth">0</b> ม.</span>' +
      '</div>';
    document.body.appendChild(panel);

    var sld = panel.querySelector("#lfSld"),
        playBtn = panel.querySelector("#lfPlay"),
        tlab = panel.querySelector("#lfTime"),
        pct = panel.querySelector("#lfPct"),
        depth = panel.querySelector("#lfDepth"),
        ico = playBtn.querySelector("i");

    var cur = 0, timer = null;

    function show(i) {
      cur = Math.max(0, Math.min(m.frames.length - 1, i));
      var f = m.frames[cur];
      overlay.setUrl(base + f.file);
      sld.value = cur;
      tlab.textContent = f.t_hours + " ชม.";
      pct.textContent = f.flooded_pct;
      depth.textContent = (f.depth_p95 != null ? f.depth_p95 : f.max_depth);
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } ico.className = "ti ti-player-play"; }
    function play() {
      if (timer) return stop();
      ico.className = "ti ti-player-pause";
      if (cur >= m.frames.length - 1) cur = 0;
      timer = setInterval(function () {
        if (cur >= m.frames.length - 1) { show(cur); return stop(); }
        show(cur + 1);
      }, 450);
    }

    playBtn.onclick = play;
    sld.oninput = function () { stop(); show(parseInt(sld.value, 10)); };

    map.on("overlayadd", function (e) {
      if (e.layer === group) { panel.style.display = "block"; show(0); }
    });
    map.on("overlayremove", function (e) {
      if (e.layer === group) { stop(); panel.style.display = "none"; }
    });

    show(0);
  }
})();
