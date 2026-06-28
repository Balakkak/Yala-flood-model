/* ============================================================================
 * intervention_compare.js — เปรียบเทียบน้ำท่วม "ก่อน vs หลัง" ใส่โครงสร้าง
 * ----------------------------------------------------------------------------
 * ใช้ในหน้า interventions.html — engine กลาง + renderer ทั้ง 2D (Leaflet canvas)
 * และ 3D (MapLibre WebGL water) แชร์สถานะเดียวกัน:
 *   - โหลด dem_grid + buildings_grid + yala_boundary + intervention_sim
 *   - baseline = Priority-Flood (minimax, 8-neighbour, channel seed) ที่ระดับออกแบบ
 *   - เปิด/ปิด "คันกั้น" แต่ละมาตรการ → ยกเซลล์คันกั้น → รัน Priority-Flood ซ้ำ = "หลัง"
 *   - split (0..1) คุมทั้ง 2D/3D: คอลัมน์ซ้าย < split = ก่อน, ขวา = หลัง (swipe เดียว)
 *   - สถิติ: ปริมาตรน้ำ / พื้นที่ / อาคารท่วม — ก่อน, หลัง, ลดลง
 * อัลกอริทึมตรงกับ scripts/analyze_interventions.py (ตัวเลขจึงตรงกับมาตรการที่แนะนำ)
 * ========================================================================== */
window.IVCompare = (function () {
  "use strict";

  var NC, NR, N, ground, valid, chanMask, inStudy, bld;
  var OLON, OLAT, DLON, DLAT, DESIGN_S, FREEBOARD, STAGE;
  var sim, levees = [], enabled = {};
  var baseArrival, afterArrival, statsCache;
  var split = 0.0;                 // 0 = ทั้งหมดเป็น "หลัง", 1 = ทั้งหมดเป็น "ก่อน"
  var listeners = [];
  var ready = false;
  var CELL_M2 = 30 * 30;

  function emit(kind) { listeners.forEach(function (f) { try { f(kind); } catch (e) { console.warn(e); } }); }
  var lonOf = function (c) { return OLON + (c + 0.5) * DLON; };
  var latOf = function (r) { return OLAT - (r + 0.5) * DLAT; };

  function pin(lo, la, ring) {
    var s = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > la) !== (yj > la)) && (lo < (xj - xi) * (la - yi) / (yj - yi + 1e-30) + xi)) s = !s;
    }
    return s;
  }

  // ---- Priority-Flood (minimax) 8-neighbour จาก channel seeds บน elevation ที่ให้มา ----
  function priorityFlood(elev, channel) {
    var arr = new Float32Array(N); arr.fill(Infinity);
    var k = [], v = [];
    var sw = function (a, b) { var x = k[a]; k[a] = k[b]; k[b] = x; var y = v[a]; v[a] = v[b]; v[b] = y; };
    var push = function (K, V) { var i = k.length; k.push(K); v.push(V); while (i > 0) { var p = (i - 1) >> 1; if (k[p] <= k[i]) break; sw(p, i); i = p; } };
    var pop = function () { var tk = k[0], tv = v[0], n = k.length - 1; k[0] = k[n]; v[0] = v[n]; k.pop(); v.pop(); var i = 0; while (1) { var l = 2 * i + 1, r = l + 1, s = i; if (l < k.length && k[l] < k[s]) s = l; if (r < k.length && k[r] < k[s]) s = r; if (s === i) break; sw(s, i); i = s; } return [tk, tv]; };
    var NB = [-1, 1, -NC, NC, -NC - 1, -NC + 1, NC - 1, NC + 1];
    for (var s0 = 0; s0 < channel.length; s0++) { var i0 = channel[s0]; if (valid[i0]) { arr[i0] = elev[i0]; push(elev[i0], i0); } }
    while (k.length) {
      var pr = pop(), L = pr[0], c = pr[1]; if (L > arr[c]) continue; var cx = c % NC;
      for (var d = 0; d < 8; d++) {
        var nb = c + NB[d];
        if (nb < 0 || nb >= N || !valid[nb]) continue;
        if (Math.abs((nb % NC) - cx) > 1) continue;          // กันหลุดขอบแถว (wrap)
        var nl = L > elev[nb] ? L : elev[nb];
        if (nl < arr[nb]) { arr[nb] = nl; push(nl, nb); }
      }
    }
    return arr;
  }

  // depth = STAGE − arrival เฉพาะ "น้ำท่วมในเมือง" (ในเขตศึกษา, ไม่ใช่ร่องน้ำจริง)
  function isCityFlooded(arr, i) { return inStudy[i] && !chanMask[i] && arr[i] <= STAGE; }
  function statsOf(arr) {
    var cells = 0, vol = 0, b = 0;
    for (var i = 0; i < N; i++) {
      if (isCityFlooded(arr, i)) { cells++; vol += (STAGE - arr[i]); b += bld[i]; }
    }
    return { cells: cells, area_rai: Math.round(cells * CELL_M2 / 1600),
             volume_m3: Math.round(vol * CELL_M2), buildings: Math.round(b) };
  }

  function computeAfter() {
    var elev = Float32Array.from(ground);
    var wall = DESIGN_S + FREEBOARD;
    for (var li = 0; li < levees.length; li++) {
      var lv = levees[li];
      if (!enabled[lv.rank]) continue;
      for (var w = 0; w < lv.wall_cells.length; w++) { var i = lv.wall_cells[w]; if (valid[i]) elev[i] = Math.max(elev[i], wall); }
    }
    afterArrival = priorityFlood(elev, sim._channel);
    var before = statsOf(baseArrival), after = statsOf(afterArrival);
    statsCache = {
      before: before, after: after,
      reduced: {
        cells: before.cells - after.cells,
        area_rai: before.area_rai - after.area_rai,
        volume_m3: before.volume_m3 - after.volume_m3,
        buildings: before.buildings - after.buildings,
        volume_pct: before.volume_m3 > 0 ? Math.round((before.volume_m3 - after.volume_m3) / before.volume_m3 * 1000) / 10 : 0
      }
    };
  }

  async function init() {
    if (ready) return api;
    var res = await Promise.all([
      fetch("data/dem_grid.json").then(function (r) { return r.json(); }),
      fetch("data/buildings_grid.json").then(function (r) { return r.json(); }),
      fetch("data/yala_boundary.geojson").then(function (r) { return r.json(); }),
      fetch("data/intervention_sim.json").then(function (r) { return r.json(); })
    ]);
    var G = res[0], BG = res[1], B = res[2]; sim = res[3];
    NC = G.ncols; NR = G.nrows; N = NC * NR;
    OLON = G.origin_lon; OLAT = G.origin_lat; DLON = G.dlon; DLAT = G.dlat;
    DESIGN_S = sim.design_stage_m; FREEBOARD = sim.freeboard_m; STAGE = DESIGN_S;
    ground = Float32Array.from(G.ground_m);
    valid = new Uint8Array(N);
    for (var i = 0; i < N; i++) valid[i] = (ground[i] > 0 && ground[i] < 9000 && isFinite(ground[i])) ? 1 : 0;
    var channel = (G.channel || []).filter(function (x) { return valid[x]; });
    sim._channel = channel;
    chanMask = new Uint8Array(N);
    for (var ci = 0; ci < channel.length; ci++) chanMask[channel[ci]] = 1;
    bld = Float32Array.from(BG.counts);
    var ring = B.features[0].geometry.coordinates[0];
    inStudy = new Uint8Array(N);
    for (var r = 0; r < NR; r++) for (var c = 0; c < NC; c++) {
      var ii = r * NC + c;
      if (valid[ii] && pin(lonOf(c), latOf(r), ring)) inStudy[ii] = 1;
    }
    levees = sim.levees || [];
    levees.forEach(function (l) { enabled[l.rank] = false; });
    baseArrival = priorityFlood(ground, channel);
    computeAfter();
    ready = true;
    return api;
  }

  // ---------- API ----------
  var api = {
    init: init,
    isReady: function () { return ready; },
    subscribe: function (cb) { listeners.push(cb); },
    toggle: function (rank, on) {
      enabled[rank] = (on == null) ? !enabled[rank] : !!on;
      computeAfter(); emit("after");
    },
    isEnabled: function (rank) { return !!enabled[rank]; },
    enabledCount: function () { return levees.filter(function (l) { return enabled[l.rank]; }).length; },
    setSplit: function (f) { split = Math.max(0, Math.min(1, f)); emit("split"); },
    getSplit: function () { return split; },
    splitLon: function () { return OLON + split * NC * DLON; },
    levees: function () { return levees; },
    stats: function () { return statsCache; },
    meta: function () { return { NC: NC, NR: NR, N: N, OLON: OLON, OLAT: OLAT, DLON: DLON, DLAT: DLAT, STAGE: STAGE, DESIGN_S: DESIGN_S }; },
    // เซลล์ → arrival ตามฝั่ง split (col < split*NC = ก่อน, มิฉะนั้น = หลัง)
    arrivals: function () { return { base: baseArrival, after: afterArrival }; },
    arrays: function () { return { ground: ground, valid: valid, chanMask: chanMask, inStudy: inStudy, bld: bld, channel: sim._channel }; },
    boundsLatLng: function () { return [[OLAT - NR * DLAT, OLON], [OLAT, OLON + NC * DLON]]; }
  };
  return api;
})();
