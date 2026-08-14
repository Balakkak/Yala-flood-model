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
 *     นับ "ทั้งกริด" ไม่จำกัดเขตเทศบาล (น้ำจริงไม่เลือกเขต) — ต่างจาก analyze_interventions.py
 *     ที่คัดกรองรายมาตรการเฉพาะในเขตศึกษา (ใช้จัดอันดับ ไม่ใช่สถิติหน้าเว็บ)
 * ========================================================================== */
window.IVCompare = (function () {
  "use strict";

  var NC, NR, N, ground, valid, chanMask, inStudy, bld;
  var OLON, OLAT, DLON, DLAT, DESIGN_S, FREEBOARD, STAGE;
  var sim, levees = [], enabled = {}, FR = null;
  var baseArrival, afterArrival, ctxArrival, statsCache, flowCache = null;
  var ctxFeather = null;           // 0→1 ตามระยะจากขอบเขตเมือง — เกลี่ยน้ำฉากหลังตรงรอยต่อตอนเปิดคันกั้น
  var split = 0.0;                 // 0 = ทั้งหมดเป็น "หลัง", 1 = ทั้งหมดเป็น "ก่อน"
  var listeners = [];
  var ready = false;
  var CELL_M2 = 30 * 30;
  var drainM;
  // มาตรการกายภาพ (แก้มลิง/คอขวด/ประตู) — เก็บรายจุด + สถานะเปิด/ปิดแยกอิสระ (key = เซลล์ศูนย์กลาง)
  var retentionPonds = [], bottleneckList = [], floodgateList = [];
  var enabledRetention = {}, enabledBottleneck = {}, enabledFloodgate = {};
  var canalRoutes = [];            // แนวคลองระบายน้ำเส้นใหม่ (จากแอ่งแก้มลิง → แม่น้ำ)
  // มาตรการเสริมที่ใช้โครงสร้างเดิมของเทศบาล (จำลองผ่านความจุระบาย)
  var pumpCells = [], dredgeCells = [], dredgeKm = 0;
  var enabledPumpUpgrade = false, enabledDredge = false, enabledCanal = false;

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

  // depth = STAGE − arrival — นับน้ำท่วม "ทั้งพื้นที่" ในกริด (น้ำจริงไม่เลือกเขต จึงไม่จำกัดเขตเทศบาล)
  // ยกเว้นร่องน้ำจริง (แม่น้ำ/คลอง) ซึ่งมีน้ำเป็นปกติ ไม่ใช่น้ำท่วม
  function isCityFlooded(arr, i, currentDrain) {
    var d = currentDrain ? currentDrain[i] : (drainM ? drainM[i] : 0);
    return valid[i] && !chanMask[i] && arr[i] <= STAGE && (STAGE - arr[i] - d > 0.03);
  }
  // เซลล์รับประโยชน์ "ท้ายน้ำ" ของมาตรการหน่วง/ระบาย — จุดดักน้ำ (แก้มลิง/คอขวด/ปลายคลอง)
  // มักอยู่บนที่สูงที่น้ำแม่น้ำท่วมไม่ถึง (arrival > ระดับออกแบบ) → ถ้าวางวงบริการตรงหมุด
  // จะไม่ทับพื้นที่ท่วมเลย = เปิดแล้วเห็นผล 0% เสมอ · จึงไล่ "เส้นทางน้ำ" (BFS ตาม arrival
  // ไม่เกินของจุดตั้งต้น = ทางที่น้ำจากจุดนี้ไหลเชื่อมสู่แม่น้ำ) ไปยังเซลล์แรกที่ท่วมถึง
  // เหตุการณ์ออกแบบ → ผลของมาตรการแสดงที่ย่านท้ายน้ำที่ได้ประโยชน์จริง
  function downstreamFloodCell(start) {
    if (start < 0 || start >= N || !valid[start]) return -1;
    var target = FR ? FR.onset_stage_m + 0.3 : DESIGN_S;       // ถึงที่ราบน้ำท่วมหลัก/ทางน้ำ ไม่ใช่แค่ร่องบนที่สูง
    if (chanMask[start] || baseArrival[start] <= target) return start;
    var lim = baseArrival[start], seen = {}, q = [start], qh = 0, guard = 0;
    seen[start] = 1;
    var DR = [-1, 1, 0, 0, -1, -1, 1, 1], DC = [0, 0, -1, 1, -1, 1, -1, 1];
    while (qh < q.length && guard++ < 8000) {
      var cur = q[qh++];
      if (chanMask[cur] || baseArrival[cur] <= target) return cur;
      var r = (cur / NC) | 0, c = cur % NC;
      for (var d = 0; d < 8; d++) {
        var nr = r + DR[d], nc = c + DC[d];
        if (nr < 0 || nc < 0 || nr >= NR || nc >= NC) continue;
        var j = nr * NC + nc;
        if (seen[j] || !valid[j] || baseArrival[j] > lim) continue;
        seen[j] = 1; q.push(j);
      }
    }
    return -1;                                                 // ไม่เชื่อมโซนท่วม (ไม่มีผลให้แสดง)
  }
  // กระจาย "ปริมาตรที่มาตรการดัก/ระบายได้" (ลบ.ม. — mass balance) เป็นความลึกที่ลดลง
  // เริ่มจากจุดรับน้ำท้ายน้ำ ไล่ตามผืนน้ำที่เชื่อมต่อกัน ณ ระดับปัจจุบัน (ผ่านร่อง/ทางน้ำได้
  // แต่ลดความลึกเฉพาะเซลล์เมืองนอกทางน้ำ) → น้ำระดับเริ่ม–กลาง: หย่อมแห้งชัดเจน ·
  // เหตุการณ์ใหญ่: ผลเล็กตามจริง (ปริมาตรบ่อ/คลองเล็กมากเทียบปริมาตรน้ำแม่น้ำ)
  function applyVolumeRelief(d, start, volM3) {
    if (start < 0 || start >= N || !isFinite(volM3) || volM3 <= 0) return;
    var arr = afterArrival || baseArrival;
    var budget = volM3, seen = {}, q = [start], qh = 0;
    seen[start] = 1;
    var DR = [-1, 1, 0, 0], DC = [0, 0, -1, 1];
    while (qh < q.length && budget > 0 && qh < 20000) {
      var cur = q[qh++];
      if (!chanMask[cur]) {                                    // ลดความลึกทุกเซลล์ผืนน้ำ (นับทั้งพื้นที่ ไม่จำกัดเขต)
        var rem = STAGE - arr[cur] - d[cur];                   // ความลึกที่เหลือหลังหักระบายอื่น
        if (rem > 0.03) {
          var relief = Math.min(rem, budget / CELL_M2);
          d[cur] += relief; budget -= relief * CELL_M2;
        }
      }
      var r = (cur / NC) | 0, c = cur % NC;
      for (var k = 0; k < 4; k++) {
        var nr = r + DR[k], nc = c + DC[k];
        if (nr < 0 || nc < 0 || nr >= NR || nc >= NC) continue;
        var j = nr * NC + nc;
        if (seen[j] || !valid[j]) continue;
        if (!chanMask[j] && arr[j] > STAGE) continue;          // เดินเฉพาะผืนน้ำ/ทางน้ำที่เชื่อมกัน
        seen[j] = 1; q.push(j);
      }
    }
  }
  // จานวงกลมไล่ระดับ (ศูนย์กลางเต็ม peak → ขอบ 0) — "รัศมีบริการ" ของมาตรการเฉพาะจุด
  // วงกลม+ไล่ระดับ (ไม่ใช่สี่เหลี่ยมค่าคงที่) → น้ำรอบมาตรการแห้ง/ตื้นลงแบบเป็นธรรมชาติ มองเห็นผลชัด
  function addDrainDisk(d, r0, c0, rad, peak) {
    for (var r = Math.max(0, r0 - rad); r <= Math.min(NR - 1, r0 + rad); r++)
      for (var c = Math.max(0, c0 - rad); c <= Math.min(NC - 1, c0 + rad); c++) {
        var dr = r - r0, dc = c - c0, dist = Math.sqrt(dr * dr + dc * dc);
        if (dist > rad) continue;
        d[r * NC + c] += peak * (1 - dist / (rad + 1));
      }
  }
  // ความจุระบายที่ใช้งานจริง = ค่า DEM (drainM) + ผลของมาตรการที่ "เปิด" อยู่เท่านั้น (รายจุด)
  //   แก้มลิง: เซลล์บ่อ +2.5 ม. + รัศมีบริการ ~180 ม. (ไล่ระดับสูงสุด 1.2)
  //   คอขวด (เพิ่มท่อ/สูบ): รัศมี ~150 ม. (ไล่ระดับสูงสุด 1.2)
  //   อัปเกรดสถานีสูบเดิม / ขุดลอกคลองเดิม / คลองเส้นใหม่: ตามจุด/แนวจริง
  function getActiveDrain() {
    var d = new Float32Array(N);
    if (drainM) { for (var i = 0; i < N; i++) d[i] = drainM[i]; }
    // แก้มลิง/คอขวด/คลองใหม่ตั้งบนเส้นทางน้ำหลาก "ต้นทาง" ที่สูงกว่าระดับแม่น้ำท่วมถึง
    // (arrival 19–26 ม. > เหตุการณ์ออกแบบ) → ลดความลึกตรงหมุดอย่างเดียวจะได้ 0% เสมอ
    // จึงส่งผลเป็น "ปริมาตรที่ดัก/ระบายได้" ไปยังผืนน้ำท้ายน้ำที่จุดนั้นเชื่อมถึง (mass balance)
    retentionPonds.forEach(function (p) {
      if (!enabledRetention[p.cell]) return;
      // ผลรวมของบ่อ = "ความจุกักเก็บ" (mass-balance) — ห้ามเกินความจุ ไม่ว่าบ่อเล็กหรือใหญ่
      // ลดความลึกในเซลล์บ่อก่อน (สูงสุด 2.5 ม.) โดยหักจากงบความจุ แล้วเทส่วนที่เหลือไปช่วยผืนน้ำท้ายน้ำ
      var arrR = afterArrival || baseArrival;
      var cap = p.storage || 7200, used = 0;
      for (var k = 0; k < p.cells.length && used < cap; k++) {
        var idx = p.cells[k]; if (idx < 0 || idx >= N) continue;
        var rem = STAGE - arrR[idx] - d[idx];                  // ความลึกน้ำที่ยังเหลือในเซลล์บ่อ
        if (rem <= 0) continue;
        var take = Math.min(2.5, rem, (cap - used) / CELL_M2); // ไม่เกิน 2.5 ม. และไม่เกินงบที่เหลือ
        d[idx] += take; used += take * CELL_M2;
      }
      if (p.eff === undefined) p.eff = downstreamFloodCell(p.cell);
      if (used < cap) applyVolumeRelief(d, p.eff, cap - used); // ส่วนที่เหลือของความจุ → หักผืนน้ำท้ายน้ำ
    });
    bottleneckList.forEach(function (b) {
      if (!enabledBottleneck[b.cell]) return;
      addDrainDisk(d, b.r, b.c, 5, 1.2);                       // แก้ท่วมขังรอบจุด (ถ้าน้ำถึง)
      if (b.eff === undefined) b.eff = downstreamFloodCell(b.cell);
      applyVolumeRelief(d, b.eff, 12000);                      // ท่อ/สูบเพิ่ม ~1 ลบ.ม./วิ ระบายรอบ ~3 ชม. (screening)
    });
    // สถานีสูบรับน้ำจากโครงข่ายท่อทั้งย่าน → รัศมีบริการ ~240 ม. (8 เซลล์) ต่อสถานี
    if (enabledPumpUpgrade) pumpCells.forEach(function (p) { addDrainDisk(d, p.r, p.c, 8, 1.0); });
    if (enabledDredge) for (var k2 = 0; k2 < dredgeCells.length; k2++)
      addDrainDisk(d, (dredgeCells[k2] / NC) | 0, dredgeCells[k2] % NC, 2, 0.5);
    if (enabledCanal) canalRoutes.forEach(function (rt) {
      for (var k3 = 0; k3 < rt.cells.length; k3++)
        addDrainDisk(d, (rt.cells[k3] / NC) | 0, rt.cells[k3] % NC, 2, 0.8);
      // ปลายคลองเทลงทางน้ำ — ประโยชน์ = หน้าตัดคลอง (~6 ตร.ม./ม.) × ความยาว พาน้ำออกจากผืนท่วมที่เชื่อมถึง
      if (rt.eff === undefined) rt.eff = downstreamFloodCell(rt.cells[rt.cells.length - 1]);
      applyVolumeRelief(d, rt.eff, rt.length_m * 6);
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
    // full=true: จำลองทั้งกริด — น้ำจริงไม่เลือกเขต สถิติ/ภาพจึงคิดรวมทั้งเมืองและพื้นที่รอบนอก
    afterArrival = priorityFlood(elevWithLevees(), sim._channel, true);
    flowCache = null;                      // สนามการไหลเปลี่ยนเมื่อสิ่งก่อสร้างเปลี่ยน
    recalcStats();
  }

  // ---- ผลรายมาตรการ (marginal) : "มาตรการนี้ตัวเดียวช่วยลดเท่าไร" เทียบกับชุดที่เปิดอยู่ตอนนี้ลบตัวมันออก ----
  // มาตรการกลุ่มระบาย/หน่วง (แก้มลิง/คอขวด/สูบ/ขุดลอก/คลอง) ไม่เปลี่ยน arrival → แค่ re-threshold (เร็ว)
  // มาตรการที่เปลี่ยนภูมิประเทศ (คันกั้น/ประตูระบาย) ต้องรัน Priority-Flood ใหม่ → cache กริดตามชุดที่เปิด
  var margArrCache = {};
  function elevSignature() {
    var ids = levees.filter(function (l) { return enabled[l.rank]; }).map(function (l) { return "L" + l.rank; });
    floodgateList.forEach(function (f) { if (enabledFloodgate[f.cell]) ids.push("G" + f.cell); });
    return ids.sort().join(",");
  }
  function marginalOf(kind, key) {
    if (!ready || !statsCache) return null;
    var withAfter = statsCache.after, restore = null, needPF = false;
    if (kind === "levee")      { if (!enabled[key]) return null;            enabled[key] = false;            restore = function () { enabled[key] = true; };            needPF = true; }
    else if (kind === "gate")  { if (!enabledFloodgate[key]) return null;   enabledFloodgate[key] = false;   restore = function () { enabledFloodgate[key] = true; };   needPF = true; }
    else if (kind === "ret")   { if (!enabledRetention[key]) return null;   enabledRetention[key] = false;   restore = function () { enabledRetention[key] = true; }; }
    else if (kind === "btl")   { if (!enabledBottleneck[key]) return null;  enabledBottleneck[key] = false;  restore = function () { enabledBottleneck[key] = true; }; }
    else if (kind === "pump")  { if (!enabledPumpUpgrade) return null;      enabledPumpUpgrade = false;      restore = function () { enabledPumpUpgrade = true; }; }
    else if (kind === "dredge"){ if (!enabledDredge) return null;           enabledDredge = false;           restore = function () { enabledDredge = true; }; }
    else if (kind === "canal") { if (!enabledCanal) return null;            enabledCanal = false;            restore = function () { enabledCanal = true; }; }
    else return null;
    var without;
    try {
      var arr = afterArrival;
      if (needPF) {
        var sig = elevSignature();                       // ชุดคันกั้น/ประตู "ที่เหลือ" หลังปิดตัวนี้
        if (Object.keys(margArrCache).length > 10) margArrCache = {};   // กันโตไม่จำกัด (~0.5MB/กริด)
        arr = margArrCache[sig] || (margArrCache[sig] = priorityFlood(elevWithLevees(), sim._channel, true));
      }
      without = statsOf(arr, getActiveDrain());
    } finally { restore(); }
    var dv = without.volume_m3 - withAfter.volume_m3;
    var beforeVol = statsCache.before.volume_m3;
    return {
      volume_m3: dv,
      buildings: without.buildings - withAfter.buildings,
      pct: beforeVol > 0 ? Math.round(dv / beforeVol * 1000) / 10 : 0
    };
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
      fetch("data/intervention_candidates.geojson?t=" + t).then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("data/yala_pump_stations.geojson?t=" + t).then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("data/yala_drainage_network_filtered.geojson?t=" + t).then(function (r) { return r.json(); }).catch(function () { return null; })
    ]);
    var G = res[0], BG = res[1], B = res[2]; sim = res[3]; FR = res[4]; var cand = res[5];
    var pumpsFc = res[6], drainNet = res[7];
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
    // feather น้ำฉากหลัง: BFS ระยะ (เซลล์) จากขอบเขตเทศบาลออกไปด้านนอก
    // เมื่อเปิดคันกั้นแล้วเมืองแห้ง น้ำบริบทนอกเขตจะค่อย ๆ ตื้น/จางเข้าหาเมือง แทนการถูกตัดเป็นหน้าผาตรงเส้นเขต
    (function () {
      var K = 14;                                   // ~14 เซลล์ (~420 ม.) ช่วงเกลี่ย
      var dist = new Int32Array(N); dist.fill(-1);
      var q = new Int32Array(N), qh = 0, qt = 0;
      for (var i0 = 0; i0 < N; i0++) if (inStudy[i0]) { dist[i0] = 0; q[qt++] = i0; }
      var DR = [-1, 1, 0, 0], DC = [0, 0, -1, 1];
      while (qh < qt) {
        var cc0 = q[qh++];
        if (dist[cc0] >= K) continue;
        var r0 = (cc0 / NC) | 0, c0 = cc0 % NC;
        for (var d = 0; d < 4; d++) {
          var rr = r0 + DR[d], cn = c0 + DC[d];
          if (rr < 0 || cn < 0 || rr >= NR || cn >= NC) continue;
          var j = rr * NC + cn;
          // ไม่ข้ามร่องแม่น้ำ — ฝั่งตรงข้ามไม่มีกำแพง น้ำต้องท่วมถึงริมตลิ่งตามเดิม (ไม่จาง)
          if (dist[j] >= 0 || !valid[j] || chanMask[j]) continue;
          dist[j] = dist[cc0] + 1; q[qt++] = j;
        }
      }
      ctxFeather = new Float32Array(N);
      for (var i1 = 0; i1 < N; i1++)
        ctxFeather[i1] = inStudy[i1] ? 1 : (dist[i1] < 0 ? 1 : Math.min(1, dist[i1] / K));
    })();
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
    // มาตรการเสริม 1: อัปเกรดสถานีสูบน้ำเดิม — ตำแหน่งจริงของเทศบาล (11 สถานี)
    pumpCells = [];
    if (pumpsFc && pumpsFc.features) pumpsFc.features.forEach(function (f) {
      var g = f.geometry; if (!g || g.type !== "Point") return;
      var c = Math.floor((g.coordinates[0] - OLON) / DLON), r = Math.floor((OLAT - g.coordinates[1]) / DLAT);
      if (r >= 0 && c >= 0 && r < NR && c < NC) pumpCells.push({ r: r, c: c });
    });
    // มาตรการเสริม 2: ขุดลอกคลอง/คูระบายเดิม — rasterize โครงข่ายคลองลงกริด + วัดความยาวรวม
    dredgeCells = []; dredgeKm = 0;
    if (drainNet && drainNet.features) {
      var seenDr = new Uint8Array(N);
      drainNet.features.forEach(function (f) {
        var g = f.geometry; if (!g || g.type !== "LineString") return;
        var cs = g.coordinates;
        for (var k = 0; k < cs.length - 1; k++) {
          dredgeKm += haversine(cs[k], cs[k + 1]) / 1000;
          var x1 = (cs[k][0] - OLON) / DLON, y1 = (OLAT - cs[k][1]) / DLAT;
          var x2 = (cs[k + 1][0] - OLON) / DLON, y2 = (OLAT - cs[k + 1][1]) / DLAT;
          var steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
          for (var s2 = 0; s2 <= steps; s2++) {
            var f2 = s2 / steps, cx = Math.round(x1 + (x2 - x1) * f2), cy = Math.round(y1 + (y2 - y1) * f2);
            if (cx < 0 || cy < 0 || cx >= NC || cy >= NR) continue;
            var di = cy * NC + cx;
            if (!seenDr[di] && valid[di]) { seenDr[di] = 1; dredgeCells.push(di); }
          }
        }
      });
    }
    levees = sim.levees || [];
    levees.forEach(function (l) { enabled[l.rank] = false; });
    // full=true: baseline ทั้งกริด — สถิติ/ภาพนับน้ำท่วมรวมทั้งเมือง ไม่จำกัดเขตเทศบาล (น้ำไม่เลือกเขต)
    baseArrival = priorityFlood(ground, channel, true);
    ctxArrival = baseArrival;              // คง API เดิม (เคยเป็นน้ำฉากหลังนอกเขต — ตอนนี้ผืนเดียวกับ baseline)
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
    marginalOf: marginalOf,   // ผลรายมาตรการ ณ ระดับน้ำปัจจุบัน — {volume_m3, buildings, pct ของปริมาตรท่วมก่อนมาตรการ}
    getDrain: getActiveDrain,
    getBaseDrain: function () { return drainM; },   // ความจุระบายเดิมของเมือง (ไม่รวมมาตรการ) — ฝั่ง "ก่อน" ใช้
    // เปิด/ปิดมาตรการกายภาพรายจุด (key = เซลล์ศูนย์กลางที่ UI ส่งมา) → รันจำลองซ้ำ + ปล่อยอีเวนต์
    toggleRetention: function (cell, on) { enabledRetention[cell] = (on == null) ? !enabledRetention[cell] : !!on; computeAfter(); emit("after"); },
    toggleBottleneck: function (cell, on) { enabledBottleneck[cell] = (on == null) ? !enabledBottleneck[cell] : !!on; computeAfter(); emit("after"); },
    toggleFloodgate: function (cell, on) { enabledFloodgate[cell] = (on == null) ? !enabledFloodgate[cell] : !!on; computeAfter(); emit("after"); },
    // มาตรการเสริม (drain-only — arrival ไม่เปลี่ยน จึงแค่ re-threshold สถิติ ไม่ต้องรัน Priority-Flood ซ้ำ)
    togglePumpUpgrade: function (on) { enabledPumpUpgrade = (on == null) ? !enabledPumpUpgrade : !!on; recalcStats(); emit("after"); },
    toggleDredge: function (on) { enabledDredge = (on == null) ? !enabledDredge : !!on; recalcStats(); emit("after"); },
    toggleCanalDrain: function (on) { enabledCanal = (on == null) ? !enabledCanal : !!on; recalcStats(); emit("after"); },
    extras: function () { return { pump: enabledPumpUpgrade, dredge: enabledDredge, canal: enabledCanal }; },
    pumpCount: function () { return pumpCells.length; },
    dredgeKm: function () { return dredgeKm; },
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
    // อัตราการไหล (m³/s) จากระดับน้ำแม่น้ำ (ม.รทก.) — rating curve X.40A · ใช้แสดงคู่กับระดับน้ำ
    flowOf: function (riverLv) {
      var RV = FR && FR.river; if (!RV) return 0;
      return riverLv <= RV.rating_h0 ? 0 : RV.rating_a * Math.pow(riverLv - RV.rating_h0, RV.rating_b);
    },
    // ---- ระดับน้ำปรับได้ (ฝน + ระดับน้ำแม่น้ำปัตตานี → ระดับน้ำในเมือง) ----
    stageFromInputs: function (rain, riverLv) {
      if (!FR) return STAGE;
      var M = FR.mapping, base = FR.base_stage_m, onsetRise = FR.onset_stage_m - FR.base_stage_m;
      var RV = FR.river || { rating_h0: 15.058, rating_a: 375.736, rating_b: 0.7806, bankfull_cms: 500, major_cms: 1015 };
      var QBANK = RV.bankfull_cms, QMAJ = RV.major_cms;
      rain = Math.max(0, rain);
      // ระดับน้ำแม่น้ำปัตตานี (ม.รทก.) → อัตราการไหล (rating curve X.40A) → ส่วนยกระดับน้ำในเมือง · เขื่อนบางลางรวมอยู่ในค่านี้แล้ว
      var Q = riverLv <= RV.rating_h0 ? 0 : RV.rating_a * Math.pow(riverLv - RV.rating_h0, RV.rating_b);
      var rFlow = Q <= QBANK ? onsetRise * (Q / QBANK)
        : onsetRise + Math.min((Q - QBANK) / (QMAJ - QBANK), 1.3) * M.river_extra_m;
      // 0–100 mm/hr: เหมือนเดิม (คาลิเบรตไว้) · >100 ถึง 500: ฝนสุดขั้ว น้ำสูงเพิ่มแบบเชิงเส้น (ถูกจำกัดด้วยเพดาน stage ด้านล่าง)
      var rRain = M.rain_max_m * (Math.pow(Math.min(1, rain / 100), 0.85) + Math.max(0, rain - 100) / 100 * 0.4);
      return Math.min(base + rFlow + rRain, base + FR.event_rise_m + 0.5);
    },
    stageRange: function () {
      return FR ? { min: FR.base_stage_m, max: FR.base_stage_m + FR.event_rise_m + 0.5, onset: FR.onset_stage_m, design: DESIGN_S }
        : { min: STAGE - 3, max: STAGE + 0.5, onset: STAGE - 3, design: DESIGN_S };
    },
    setStage: function (s) { var rg = this.stageRange(); STAGE = Math.max(rg.min, Math.min(rg.max, s)); recalcStats(); emit("stage"); },
    getStage: function () { return STAGE; },
    flowField: function () { if (!flowCache) computeFlow(); return flowCache; },
    meta: function () { return { NC: NC, NR: NR, N: N, OLON: OLON, OLAT: OLAT, DLON: DLON, DLAT: DLAT, STAGE: STAGE, DESIGN_S: DESIGN_S }; },
    // feather 0→1 ของเซลล์นอกเขต (ระยะจากขอบเขตเมือง) — ใช้เกลี่ยน้ำฉากหลังเมื่อเปิดคันกั้น
    ctxFeather: function () { return ctxFeather; },
    // เซลล์ → arrival ตามฝั่ง split (col < split*NC = ก่อน, มิฉะนั้น = หลัง)
    arrivals: function () { return { base: baseArrival, after: afterArrival, ctx: ctxArrival }; },
    arrays: function () { return { ground: ground, valid: valid, chanMask: chanMask, inStudy: inStudy, bld: bld, channel: sim._channel }; },
    boundsLatLng: function () { return [[OLAT - NR * DLAT, OLON], [OLAT, OLON + NC * DLON]]; }
  };
  return api;
})();
