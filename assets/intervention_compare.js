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
  var sim, levees = [], enabled = {}, FR = null;
  var baseArrival, afterArrival, ctxArrival, statsCache, flowCache = null;
  var split = 0.0;                 // 0 = ทั้งหมดเป็น "หลัง", 1 = ทั้งหมดเป็น "ก่อน"
  var listeners = [];
  var ready = false;
  var CELL_M2 = 30 * 30;
  var drainM;
  // มาตรการกายภาพ (แก้มลิง/คอขวด/ประตู) — เก็บรายจุด + สถานะเปิด/ปิดแยกอิสระ (key = เซลล์ศูนย์กลาง)
  var retentionPonds = [], bottleneckList = [], floodgateList = [];
  var enabledRetention = {}, enabledBottleneck = {}, enabledFloodgate = {};
  var canalRoutes = [];            // แนวคลองระบายน้ำเส้นใหม่ (จากแอ่งแก้มลิง → แม่น้ำ)

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
  // full=true → ไม่จำกัดเขตศึกษา (ใช้ทำ "น้ำฉากหลัง" นอกเขตเทศบาล ให้ภาพต่อเนื่องกับหน้าจำลองน้ำท่วม)
  function priorityFlood(elev, channel, full) {
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
        if (!full && !inStudy[nb] && !chanMask[nb]) continue; // โหมดปกติ: จำกัดเฉพาะในเขตศึกษา + แม่น้ำ
        if (Math.abs((nb % NC) - cx) > 1) continue;          // กันหลุดขอบแถว (wrap)
        var nl = L > elev[nb] ? L : elev[nb];
        if (nl < arr[nb]) { arr[nb] = nl; push(nl, nb); }
      }
    }
    return arr;
  }

  // depth = STAGE − arrival เฉพาะ "น้ำท่วมในเมือง" (ในเขตศึกษา, ไม่ใช่ร่องน้ำจริง)
  function isCityFlooded(arr, i, currentDrain) {
    var d = currentDrain ? currentDrain[i] : (drainM ? drainM[i] : 0);
    return inStudy[i] && !chanMask[i] && arr[i] <= STAGE && (STAGE - arr[i] - d > 0.03);
  }
  // ความจุระบายที่ใช้งานจริง = ค่า DEM (drainM) + ผลของมาตรการที่ "เปิด" อยู่เท่านั้น (รายจุด)
  //   แก้มลิง: ยกความจุระบายที่เซลล์บ่อ (+2.5 ม.) + กระจายรอบศูนย์กลางรัศมี 4 เซลล์ (+0.6)
  //   คอขวด (เพิ่มท่อ/สูบ): +1.0 ม. รัศมี 5 เซลล์
  function getActiveDrain() {
    var d = new Float32Array(N);
    if (drainM) { for (var i = 0; i < N; i++) d[i] = drainM[i]; }
    retentionPonds.forEach(function (p) {
      if (!enabledRetention[p.cell]) return;
      for (var k = 0; k < p.cells.length; k++) { var idx = p.cells[k]; if (idx >= 0 && idx < N) d[idx] += 2.5; }
      var rad = 4;
      for (var r = Math.max(0, p.r - rad); r <= Math.min(NR - 1, p.r + rad); r++)
        for (var c = Math.max(0, p.c - rad); c <= Math.min(NC - 1, p.c + rad); c++) d[r * NC + c] += 0.6;
    });
    bottleneckList.forEach(function (b) {
      if (!enabledBottleneck[b.cell]) return;
      var rad = 5;
      for (var r = Math.max(0, b.r - rad); r <= Math.min(NR - 1, b.r + rad); r++)
        for (var c = Math.max(0, b.c - rad); c <= Math.min(NC - 1, b.c + rad); c++) d[r * NC + c] += 1.0;
    });
    return d;
  }
  function statsOf(arr, drain) {
    var cells = 0, vol = 0, b = 0;
    var currentDrain = drain || getActiveDrain();
    for (var i = 0; i < N; i++) {
      if (isCityFlooded(arr, i, currentDrain)) {
        cells++;
        var d = STAGE - arr[i] - currentDrain[i];
        vol += d > 0 ? d : 0;
        b += bld[i];
      }
    }
    return { cells: cells, area_rai: Math.round(cells * CELL_M2 / 1600),
             volume_m3: Math.round(vol * CELL_M2), buildings: Math.round(b) };
  }

  // elevation ground + ยกเซลล์คันกั้นที่เปิดใช้งาน (ใช้ทั้งคำนวณ "หลัง" และสนามการไหล)
  function elevWithLevees() {
    var elev = Float32Array.from(ground), wall = DESIGN_S + FREEBOARD;
    for (var li = 0; li < levees.length; li++) {
      var lv = levees[li];
      if (!enabled[lv.rank]) continue;
      for (var w = 0; w < lv.wall_cells.length; w++) { var i = lv.wall_cells[w]; if (valid[i]) elev[i] = Math.max(elev[i], wall); }
    }
    if (floodgateList.length) {
      for (var fi = 0; fi < floodgateList.length; fi++) {
        var idx = floodgateList[fi].cell;
        if (!enabledFloodgate[idx]) continue;
        if (valid[idx]) {
          elev[idx] = Math.max(elev[idx], wall);
          var r = Math.floor(idx / NC), c = idx % NC;
          var DR = [-1, 1, 0, 0], DC = [0, 0, -1, 1];
          for (var d = 0; d < 4; d++) {
            var nr = r + DR[d], nc = c + DC[d];
            if (nr >= 0 && nr < NR && nc >= 0 && nc < NC) {
              var nidx = nr * NC + nc;
              if (valid[nidx]) elev[nidx] = Math.max(elev[nidx], wall);
            }
          }
        }
      }
    }
    return elev;
  }
  function recalcStats() {                 // re-threshold ที่ STAGE ปัจจุบัน (ไม่รัน Priority-Flood)
    // "ก่อน" = ไม่มีมาตรการเลย (terrain เดิม + ระบายตาม DEM) · "หลัง" = คันกั้น + มาตรการที่เปิดอยู่
    // แยกความจุระบายชัดเจน ไม่ให้ผลของแก้มลิง/คอขวดถูกใส่ทั้งสองฝั่งจนหักล้างกัน
    var before = statsOf(baseArrival, drainM), after = statsOf(afterArrival, getActiveDrain());
    statsCache = {
      before: before, after: after,
      reduced: {
        cells: before.cells - after.cells, area_rai: before.area_rai - after.area_rai,
        volume_m3: before.volume_m3 - after.volume_m3, buildings: before.buildings - after.buildings,
        volume_pct: before.volume_m3 > 0 ? Math.round((before.volume_m3 - after.volume_m3) / before.volume_m3 * 1000) / 10 : 0
      }
    };
  }
  function computeAfter() {
    afterArrival = priorityFlood(elevWithLevees(), sim._channel);
    flowCache = null;                      // สนามการไหลเปลี่ยนเมื่อสิ่งก่อสร้างเปลี่ยน
    recalcStats();
  }

  // ---- สนามทิศการไหล D8 (steepest descent) บน elevation หลังมีสิ่งก่อสร้าง ----
  function computeFlow() {
    var elev = elevWithLevees();
    var fx = new Float32Array(N), fy = new Float32Array(N);
    var DR = [-1, 1, 0, 0, -1, -1, 1, 1], DC = [0, 0, -1, 1, -1, 1, -1, 1];
    for (var i = 0; i < N; i++) {
      if (!valid[i]) continue;
      var r = (i / NC) | 0, c = i % NC, best = elev[i], br = 0, bc = 0, found = false;
      for (var d = 0; d < 8; d++) {
        var nr = r + DR[d], nc = c + DC[d];
        if (nr < 0 || nc < 0 || nr >= NR || nc >= NC) continue;
        var j = nr * NC + nc;
        if (!valid[j]) continue;
        if (elev[j] < best) { best = elev[j]; br = DR[d]; bc = DC[d]; found = true; }
      }
      if (found) { var len = Math.sqrt(bc * bc + br * br); fx[i] = bc / len; fy[i] = br / len; }  // fx=+ตะวันออก, fy=+ใต้(row เพิ่ม)
    }
    flowCache = { fx: fx, fy: fy };
  }

  // ระยะทางภูมิศาสตร์ (เมตร) ระหว่าง 2 จุด [lng,lat] — คิดความยาวคลอง
  function haversine(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLa = (b[1] - a[1]) * toR, dLo = (b[0] - a[0]) * toR;
    var la1 = a[1] * toR, la2 = b[1] * toR;
    var h = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---- คลองระบายน้ำเส้นใหม่: least-cost path จากแอ่งแก้มลิง → แม่น้ำ ----
  // Dijkstra ออกจากเซลล์แม่น้ำทุกจุด (prev ชี้กลับสู่แม่น้ำ) ต้นทุนก้าว = ฐาน + โทษ "ขึ้นเนิน" + โทษทับอาคาร
  //   → เส้นที่ได้ = แนวไหลลงต่ำสุดสู่แม่น้ำ เลี่ยงอาคาร (แนวคลองที่ควรขุด) แล้ว backtrack จากแต่ละบ่อ
  function computeCanals() {
    canalRoutes = [];
    if (!retentionPonds.length || !sim || !sim._channel) return;
    var g = new Float32Array(N); g.fill(Infinity);
    var prev = new Int32Array(N); prev.fill(-1);
    var hk = [], hv = [];
    var sw = function (a, b) { var x = hk[a]; hk[a] = hk[b]; hk[b] = x; var y = hv[a]; hv[a] = hv[b]; hv[b] = y; };
    var push = function (K, V) { var i = hk.length; hk.push(K); hv.push(V); while (i > 0) { var p = (i - 1) >> 1; if (hk[p] <= hk[i]) break; sw(p, i); i = p; } };
    var pop = function () { var tv = hv[0], n = hk.length - 1; hk[0] = hk[n]; hv[0] = hv[n]; hk.pop(); hv.pop(); var i = 0; while (1) { var l = 2 * i + 1, r = l + 1, s = i; if (l < hk.length && hk[l] < hk[s]) s = l; if (r < hk.length && hk[r] < hk[s]) s = r; if (s === i) break; sw(s, i); i = s; } return tv; };
    var NB = [-1, 1, -NC, NC, -NC - 1, -NC + 1, NC - 1, NC + 1];
    for (var s0 = 0; s0 < sim._channel.length; s0++) { var ci = sim._channel[s0]; if (valid[ci]) { g[ci] = 0; push(0, ci); } }
    while (hk.length) {
      var c = pop(), gc = g[c], cx = c % NC;
      for (var d = 0; d < 8; d++) {
        var nb = c + NB[d];
        if (nb < 0 || nb >= N || !valid[nb]) continue;
        if (!inStudy[nb] && !chanMask[nb]) continue;
        if (Math.abs((nb % NC) - cx) > 1) continue;
        var up = ground[nb] - ground[c]; if (up < 0) up = 0;
        var ng = gc + 1 + up * 3 + (bld[nb] > 0 ? bld[nb] * 2 : 0);
        if (ng < g[nb]) { g[nb] = ng; prev[nb] = c; push(ng, nb); }
      }
    }
    retentionPonds.forEach(function (p) {
      var start = p.cell;
      if (!valid[start] || (prev[start] < 0 && !chanMask[start])) return;   // ต่อแม่น้ำไม่ได้
      var cells = [], cur = start, guard = 0;
      while (cur >= 0 && !chanMask[cur] && guard++ < 6000) { cells.push(cur); cur = prev[cur]; }
      if (cur >= 0) cells.push(cur);                                        // เซลล์แม่น้ำปลายทาง
      if (cells.length < 3) return;                                         // สั้นเกิน = อยู่ติดแม่น้ำอยู่แล้ว
      var line = cells.map(function (i) { return [lonOf(i % NC), latOf((i / NC) | 0)]; });
      var len = 0; for (var k = 1; k < line.length; k++) len += haversine(line[k - 1], line[k]);
      canalRoutes.push({ pondCell: start, cells: cells, line: line, length_m: Math.round(len),
        from: { lng: lonOf(start % NC), lat: latOf((start / NC) | 0) } });
    });
  }

  async function init() {
    if (ready) return api;
    var t = Date.now();
    var res = await Promise.all([
      fetch("data/dem_grid.json?t=" + t).then(function (r) { return r.json(); }),
      fetch("data/buildings_grid.json?t=" + t).then(function (r) { return r.json(); }),
      fetch("data/yala_boundary.geojson?t=" + t).then(function (r) { return r.json(); }),
      fetch("data/intervention_sim.json?t=" + t).then(function (r) { return r.json(); }),
      fetch("data/flood_response.json?t=" + t).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch("data/intervention_candidates.geojson?t=" + t).then(function (r) { return r.json(); }).catch(function () { return null; })
    ]);
    var G = res[0], BG = res[1], B = res[2]; sim = res[3]; FR = res[4]; var cand = res[5];
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
    drainM = new Float32Array(N);
    if (G.drain_cm) {
      for (var i = 0; i < N; i++) drainM[i] = (G.drain_cm[i] || 0) / 100;
    }
    retentionPonds = []; bottleneckList = []; floodgateList = [];
    enabledRetention = {}; enabledBottleneck = {}; enabledFloodgate = {};
    if (cand && cand.features) {
      cand.features.forEach(function (f) {
        var p = f.properties || {}, g = f.geometry || {};
        if (g.type !== "Point") return;
        var lng = g.coordinates[0], lat = g.coordinates[1];
        var c = Math.floor((lng - OLON) / DLON), r = Math.floor((OLAT - lat) / DLAT);
        var idx = r * NC + c;
        if (p.kind === "retention") {
          var cells = [];
          if (p.cells && p.cells.length) {
            p.cells.forEach(function (cell) {
              var cc = Math.floor((cell[0] - OLON) / DLON), rr = Math.floor((OLAT - cell[1]) / DLAT);
              cells.push(rr * NC + cc);
            });
          }
          retentionPonds.push({ cell: idx, r: r, c: c, cells: cells,
            storage: p.storage_m3 || (cells.length * CELL_M2 * 2.0) });   // ปริมาตรกักเก็บ (ลบ.ม.) สำหรับคิด mass-balance
        } else if (p.kind === "bottleneck") {
          bottleneckList.push({ cell: idx, r: r, c: c });
        } else if (p.kind === "floodgate") {
          floodgateList.push({ cell: idx });
        }
      });
    }
    levees = sim.levees || [];
    levees.forEach(function (l) { enabled[l.rank] = false; });
    baseArrival = priorityFlood(ground, channel);
    // น้ำ "ฉากหลัง" ทั้งกริด (นอกเขตเทศบาล) — บริบทภาพเท่านั้น เหมือนกันทั้งก่อน/หลัง ไม่เข้าสถิติ
    ctxArrival = priorityFlood(ground, channel, true);
    computeAfter();
    computeCanals();                 // เตรียมแนวคลองระบายน้ำเส้นใหม่ (routing บนกริดจริง)
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
      computeAfter();
      emit("after");
    },
    isEnabled: function (rank) { return !!enabled[rank]; },
    enabledCount: function () { return levees.filter(function (l) { return enabled[l.rank]; }).length; },
    setSplit: function (f) { split = Math.max(0, Math.min(1, f)); emit("split"); },
    getSplit: function () { return split; },
    splitLon: function () { return OLON + split * NC * DLON; },
    levees: function () { return levees; },
    stats: function () { return statsCache; },
    getDrain: getActiveDrain,
    // เปิด/ปิดมาตรการกายภาพรายจุด (key = เซลล์ศูนย์กลางที่ UI ส่งมา) → รันจำลองซ้ำ + ปล่อยอีเวนต์
    toggleRetention: function (cell, on) { enabledRetention[cell] = (on == null) ? !enabledRetention[cell] : !!on; computeAfter(); emit("after"); },
    toggleBottleneck: function (cell, on) { enabledBottleneck[cell] = (on == null) ? !enabledBottleneck[cell] : !!on; computeAfter(); emit("after"); },
    toggleFloodgate: function (cell, on) { enabledFloodgate[cell] = (on == null) ? !enabledFloodgate[cell] : !!on; computeAfter(); emit("after"); },
    infoEnabledCount: function () {
      var n = 0;
      retentionPonds.forEach(function (p) { if (enabledRetention[p.cell]) n++; });
      bottleneckList.forEach(function (b) { if (enabledBottleneck[b.cell]) n++; });
      floodgateList.forEach(function (f) { if (enabledFloodgate[f.cell]) n++; });
      return n;
    },
    retentionEnabledCount: function () { var n = 0; retentionPonds.forEach(function (p) { if (enabledRetention[p.cell]) n++; }); return n; },
    canals: function () { return canalRoutes; },
    // ปริมาตรกักเก็บรวมของแก้มลิงที่เปิดอยู่ (ลบ.ม.) — ใช้คิด mass-balance เทียบปริมาตรน้ำท่วม
    retentionStorage: function () { var v = 0; retentionPonds.forEach(function (p) { if (enabledRetention[p.cell]) v += p.storage || 0; }); return v; },
    floodVolumeBefore: function () { return statsCache ? statsCache.before.volume_m3 : 0; },
    // ---- ระดับน้ำปรับได้ (ฝน/แม่น้ำ/เขื่อน → ระดับน้ำ) ----
    stageFromInputs: function (rain, river, dam) {
      if (!FR) return STAGE;
      var M = FR.mapping, base = FR.base_stage_m, onsetRise = FR.onset_stage_m - FR.base_stage_m;
      var cl = function (p) { return Math.max(0, Math.min(100, p)); };
      river = cl(river); rain = Math.max(0, rain); dam = cl(dam);
      var rRiver = river <= M.river_bankfull_pct ? onsetRise * (river / M.river_bankfull_pct)
        : onsetRise + (river - M.river_bankfull_pct) / (100 - M.river_bankfull_pct) * M.river_extra_m;
      var rRain = M.rain_max_m * Math.pow(Math.min(1, rain / 100), 0.85);
      var rDam = dam <= M.dam_onset_pct ? 0 : M.dam_max_m * (dam - M.dam_onset_pct) / (100 - M.dam_onset_pct);
      return Math.min(base + rRiver + rRain + rDam, base + FR.event_rise_m + 0.5);
    },
    stageRange: function () {
      return FR ? { min: FR.base_stage_m, max: FR.base_stage_m + FR.event_rise_m + 0.5, onset: FR.onset_stage_m, design: DESIGN_S }
        : { min: STAGE - 3, max: STAGE + 0.5, onset: STAGE - 3, design: DESIGN_S };
    },
    setStage: function (s) { var rg = this.stageRange(); STAGE = Math.max(rg.min, Math.min(rg.max, s)); recalcStats(); emit("stage"); },
    getStage: function () { return STAGE; },
    flowField: function () { if (!flowCache) computeFlow(); return flowCache; },
    meta: function () { return { NC: NC, NR: NR, N: N, OLON: OLON, OLAT: OLAT, DLON: DLON, DLAT: DLAT, STAGE: STAGE, DESIGN_S: DESIGN_S }; },
    // เซลล์ → arrival ตามฝั่ง split (col < split*NC = ก่อน, มิฉะนั้น = หลัง)
    arrivals: function () { return { base: baseArrival, after: afterArrival, ctx: ctxArrival }; },
    arrays: function () { return { ground: ground, valid: valid, chanMask: chanMask, inStudy: inStudy, bld: bld, channel: sim._channel }; },
    boundsLatLng: function () { return [[OLAT - NR * DLAT, OLON], [OLAT, OLON + NC * DLON]]; }
  };
  return api;
})();
