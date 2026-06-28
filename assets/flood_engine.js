/* ============================================================================
 * flood_engine.js — เครื่องจำลองน้ำท่วมในเบราว์เซอร์ (Priority-Flood)
 * ----------------------------------------------------------------------------
 * ใช้สำหรับโหมด "ปรับมาตรการสด" บนหน้า interventions.html
 *   - โหลด dem_grid.json + buildings_grid.json + yala_boundary.geojson
 *   - คำนวณน้ำท่วม baseline ที่ระดับเหตุการณ์ออกแบบ
 *   - simulateBarrier(cells) = ยกคันกั้นตามเซลล์ที่วาด → รัน Priority-Flood ซ้ำ →
 *     คืนจำนวนอาคารที่ป้องกันได้ + เซลล์ที่หลุดจากโซนน้ำท่วม (ไว้ระบายสีบนแผนที่)
 *
 * อัลกอริทึมตรงกับ scripts/validate_model.js และ flood_analysis.js (minimax)
 * ========================================================================== */
window.FloodEngine = (function () {
  "use strict";
  let NC, NR, N, ground, valid, channel = [], bld, inStudy;
  let OLON, OLAT, DLON, DLAT, DESIGN_S = 18.25, FREEBOARD = 0.5;
  let baseArrival, baseFloodedBld = 0, ready = false;

  const lonOf = (c) => OLON + (c + 0.5) * DLON;
  const latOf = (r) => OLAT - (r + 0.5) * DLAT;
  function cellAt(lat, lon) {
    const c = Math.floor((lon - OLON) / DLON), r = Math.floor((OLAT - lat) / DLAT);
    return (c >= 0 && c < NC && r >= 0 && r < NR) ? r * NC + c : -1;
  }
  function pin(lo, la, ring) {
    let s = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > la) !== (yj > la)) && (lo < (xj - xi) * (la - yi) / (yj - yi + 1e-30) + xi)) s = !s;
    }
    return s;
  }

  // Priority-Flood (minimax) จาก channel seeds บน elevation ที่ให้มา
  function priorityFlood(elev) {
    const arr = new Float32Array(N).fill(Infinity);
    const k = [], v = [];
    const sw = (a, b) => { const x = k[a]; k[a] = k[b]; k[b] = x; const y = v[a]; v[a] = v[b]; v[b] = y; };
    const push = (K, V) => { let i = k.length; k.push(K); v.push(V); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; sw(p, i); i = p; } };
    const pop = () => { const tk = k[0], tv = v[0], n = k.length - 1; k[0] = k[n]; v[0] = v[n]; k.pop(); v.pop(); let i = 0; while (1) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < k.length && k[l] < k[s]) s = l; if (r < k.length && k[r] < k[s]) s = r; if (s === i) break; sw(s, i); i = s; } return [tk, tv]; };
    const NB = [-1, 1, -NC, NC, -NC - 1, -NC + 1, NC - 1, NC + 1];
    for (const i of channel) if (valid[i]) { arr[i] = elev[i]; push(elev[i], i); }
    while (k.length) {
      const [L, c] = pop(); if (L > arr[c]) continue; const cx = c % NC;
      for (let d = 0; d < 8; d++) {
        const nb = c + NB[d];
        if (nb < 0 || nb >= N || !valid[nb]) continue;
        if (Math.abs((nb % NC) - cx) > 1) continue;
        const nl = Math.max(L, elev[nb]);
        if (nl < arr[nb]) { arr[nb] = nl; push(nl, nb); }
      }
    }
    return arr;
  }

  function floodedBuildings(arr) {
    let b = 0;
    for (let i = 0; i < N; i++) if (inStudy[i] && arr[i] <= DESIGN_S) b += bld[i];
    return b;
  }

  async function init() {
    if (ready) return api;
    const [G, BG, B, FRr] = await Promise.all([
      fetch("data/dem_grid.json").then(r => r.json()),
      fetch("data/buildings_grid.json").then(r => r.json()),
      fetch("data/yala_boundary.geojson").then(r => r.json()),
      fetch("data/flood_response.json").then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    NC = G.ncols; NR = G.nrows; N = NC * NR;
    OLON = G.origin_lon; OLAT = G.origin_lat; DLON = G.dlon; DLAT = G.dlat;
    if (FRr && FRr.event_stage_m) DESIGN_S = FRr.event_stage_m;
    ground = Float32Array.from(G.ground_m);
    valid = new Uint8Array(N);
    for (let i = 0; i < N; i++) valid[i] = (ground[i] > 0 && ground[i] < 9000 && isFinite(ground[i])) ? 1 : 0;
    channel = (G.channel || []).filter(i => valid[i]);
    bld = Float32Array.from(BG.counts);
    // study mask
    const ring = B.features[0].geometry.coordinates[0];
    inStudy = new Uint8Array(N);
    for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) {
      const i = r * NC + c;
      if (valid[i] && pin(lonOf(c), latOf(r), ring)) inStudy[i] = 1;
    }
    baseArrival = priorityFlood(ground);
    baseFloodedBld = floodedBuildings(baseArrival);
    ready = true;
    return api;
  }

  // แปลง polyline (array ของ [lat,lon]) → เซลล์ที่เส้นผ่าน (+buffer 1 เซลล์ = กำแพงทึบ)
  function cellsAlongLine(latlngs, buffer) {
    buffer = buffer == null ? 1 : buffer;
    const set = new Set();
    const add = (r, c) => {
      for (let dr = -buffer; dr <= buffer; dr++) for (let dc = -buffer; dc <= buffer; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < NR && cc >= 0 && cc < NC) set.add(rr * NC + cc);
      }
    };
    for (let s = 0; s < latlngs.length - 1; s++) {
      const a = latlngs[s], b = latlngs[s + 1];
      const x1 = (a[1] - OLON) / DLON, y1 = (OLAT - a[0]) / DLAT;
      const x2 = (b[1] - OLON) / DLON, y2 = (OLAT - b[0]) / DLAT;
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
      for (let t = 0; t <= steps; t++) {
        const f = t / steps;
        add(Math.floor(y1 + (y2 - y1) * f), Math.floor(x1 + (x2 - x1) * f));
      }
    }
    return [...set];
  }

  // จำลองคันกั้น: ยกเซลล์ที่ให้มาให้สูงถึง design+freeboard แล้วรันใหม่
  function simulateBarrier(cells) {
    const elev = Float32Array.from(ground);
    const wall = DESIGN_S + FREEBOARD;
    for (const i of cells) if (valid[i]) elev[i] = Math.max(elev[i], wall);
    const arr = priorityFlood(elev);
    const after = floodedBuildings(arr);
    // เซลล์ที่หลุดจากน้ำท่วม (baseline ท่วม แต่ตอนนี้ไม่ท่วม) — ไว้ระบายสีบนแผนที่
    const dried = [];
    for (let i = 0; i < N; i++)
      if (inStudy[i] && baseArrival[i] <= DESIGN_S && arr[i] > DESIGN_S) dried.push(i);
    return { floodedBld: after, protected: Math.max(0, baseFloodedBld - after), driedCells: dried };
  }

  function cellBounds(i) {
    const r = Math.floor(i / NC), c = i % NC;
    return [[OLAT - (r + 1) * DLAT, OLON + c * DLON], [OLAT - r * DLAT, OLON + (c + 1) * DLON]];
  }

  const api = {
    init,
    cellsAlongLine,
    simulateBarrier,
    cellAt,
    cellBounds,
    get baseFloodedBld() { return baseFloodedBld; },
    get designStage() { return DESIGN_S; },
    get isReady() { return ready; },
  };
  return api;
})();
