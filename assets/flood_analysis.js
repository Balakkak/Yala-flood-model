/* ============================================================================
 * flood_analysis.js
 * ----------------------------------------------------------------------------
 * ตัววิเคราะห์การแพร่ของน้ำท่วมจาก DEM จริง (AW3D30) สำหรับเทศบาลนครยะลา
 *
 * วิธีการ (screening-level, ก่อนต่อยอดเป็น HEC-RAS 2D):
 *   Priority-Flood / minimax-connectivity flooding
 *   - มองว่าระดับน้ำค่อย ๆ ยกตัวขึ้นจาก "แหล่งน้ำ" = แม่น้ำปัตตานี
 *   - สำหรับทุกเซลล์ของ DEM หา "ระดับน้ำต่ำสุดที่ทำให้เซลล์นั้นเชื่อมต่อ
 *     (hydraulically connected) กับแม่น้ำ" = arrival level
 *       arrival[nb] = max( arrival[cur], elev[nb] )   (เส้นทางแบบ minimax)
 *   - เซลล์ที่ arrival ต่ำ + อยู่ติดแม่น้ำ => ท่วมก่อน
 *   - ความลึก ณ ระดับน้ำผิว S : depth = S - elev (เฉพาะเซลล์ที่ arrival <= S)
 *
 * ให้ผลลัพธ์: (1) ลำดับท่วมก่อน-หลัง (2) ทิศทาง/แหล่งที่น้ำมา (3) ความลึกรายเวลา
 *
 * หมายเหตุ: DEM ถูก min-pool downsample เพื่อความเร็ว และคิดสถิติเทียบกับ
 *           "ขอบเขตเมือง" (study mask) เพื่อให้ % พื้นที่ท่วมสื่อความหมาย
 * ========================================================================== */

(function () {
  "use strict";

  // --- DOM hooks ---
  const sld   = document.getElementById("sld");
  const tlab  = document.getElementById("tlab");
  const play  = document.getElementById("play");
  const pico  = document.getElementById("pico");
  const ptxt  = document.getElementById("ptxt");
  const badge = document.getElementById("scenarioBadge");
  const elArea  = document.getElementById("anFloodArea");
  const elDepth = document.getElementById("anMaxDepth");
  const elBar   = document.getElementById("anProgressBar");
  const elNote  = document.getElementById("anNote");
  const setStatus = (m) => { if (elNote) elNote.textContent = m; };

  // --- สถานการณ์: pct = สัดส่วนพื้นที่เมืองที่ถูกน้ำท่วม ณ จุดสูงสุด ---
  // (pace ตามลำดับการท่วมจริง เพราะ AW3D30 30 ม. ปั้นระดับสัมบูรณ์ไม่แม่นพอ — ดู README/AAR)
  const SCENARIOS = {
    base:   { name: "น้ำหลากจากแม่น้ำปัตตานี (ปกติ)", pct: 0.35, depthRef: 0.6  },
    high:   { name: "เขื่อนบางลางเร่งระบาย (วิกฤต)",  pct: 0.65, depthRef: 1.2  },
    custom: { name: "จำลองตามผู้ใช้กำหนด",            pct: 0.25, depthRef: 0.5  },
  };
  // depthRef = ความลึกสูงสุดอ้างอิงจาก AAR 2568 / City Digital Data Platform (ม.)
  // ใช้ calibrate ค่าที่แสดงให้สอดคล้องกับเหตุการณ์จริง แทนการใช้ค่าดิบจาก DEM ที่มี ±5ม. error
  let scenario = "base";

  // --- Simulation inputs (from user sliders) ---
  let simInputs = { rainfall: 0, damLevel: 50, river: 50 };
  let _lastSimDrainage = false;

  // --- Rain zone state ---
  let rainZones = [];
  let rainDrawMode = false;
  let rainZoneMultiplier = 1.5;
  let rainZoneRadiusM = 2000;
  let _rainZoneIdCounter = 0;

  // --- Long-run duration ---
  let simLongRunHours = 24;

  // --- ค่าคงที่การประมวลผล ---
  const TARGET_DIM = 560; // ขนาดกริดเป้าหมายหลัง downsample (ด้านยาว)
  const ARROW_SCALE = 2;  // ความละเอียดของเลเยอร์ลูกศร (เท่าของกริด)

  // --- สถานะแบบจำลอง ---
  let DEM = null;        // { W, H, elev, valid, bbox }
  let inStudy = null;    // Uint8Array : เซลล์ในเขตเมือง (study mask)
  let inRegion = null;   // Uint8Array : เขตเมือง + buffer (กรอบวิเคราะห์/แสดงผล)
  let cityDrainageGlobal = null;  // เก็บ drainage layer ไว้สำหรับ scenario-aware seeding
  let studyCount = 0;
  let arrival = null;    // Float32Array : ระดับน้ำที่เซลล์เชื่อมต่อแม่น้ำ
  let base0 = 0;         // ระดับฐาน (ก้นแม่น้ำ)
  let surfaceMax = 0;    // ระดับน้ำผิวสูงสุดของสถานการณ์
  let sortedReach = null;// arrival ของเซลล์ที่จะท่วม (เรียงจากน้อย→มาก) สำหรับ pacing
  let floodOverlay = null, orderOverlay = null, arrowOverlay = null;

  let t = 0, playing = false, draining = false, animTimer = null;
  let drainProgress = 0; // 0=full flood visible, 1=fully drained (drives fade + corridor reveal)

  // --- Wave + particle animation state ---
  const D8_DX = [-1, 1,  0, 0, -1,  1, -1, 1];
  const D8_DY = [ 0, 0, -1, 1, -1, -1,  1, 1];
  const N_PARTICLES = 1200;
  let d8 = null;
  let _flowAcc = null;   // upstream cell count per cell — high value = main drainage corridor
  let _maxFlowAcc = 1;   // normalisation denominator
  let waveT = 0, _waveAnimId = null, _lastWaveTs = 0;
  let _waveCv = null, _waveCx = null, _waveImg = null;
  let particles = null, floodedCellList = null, cachedFlood = null;

  /* ---- Min-heap (key=ระดับน้ำ, value=index) ---- */
  function MinHeap() {
    const k = [], v = [];
    const swap = (a, b) => { const x = k[a]; k[a] = k[b]; k[b] = x; const y = v[a]; v[a] = v[b]; v[b] = y; };
    return {
      size: () => k.length,
      push(key, val) { let i = k.length; k.push(key); v.push(val); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; swap(p, i); i = p; } },
      pop() {
        const tk = k[0], tv = v[0], n = k.length - 1;
        k[0] = k[n]; v[0] = v[n]; k.pop(); v.pop();
        let i = 0;
        while (true) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < k.length && k[l] < k[s]) s = l; if (r < k.length && k[r] < k[s]) s = r; if (s === i) break; swap(s, i); i = s; }
        return [tk, tv];
      },
    };
  }

  const bboxToLatLng = (b) => [[b[1], b[0]], [b[3], b[2]]];

  // point-in-polygon (ray casting) บนวง coordinates [[lon,lat],...]
  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ----------------------------------------------------------------------- *
   * 1) โหลด DEM + แม่น้ำ + ขอบเขตเมือง
   * ----------------------------------------------------------------------- */
  setStatus("กำลังโหลดและวิเคราะห์ภูมิประเทศ (DEM)...");
  const j = (u) => fetch(u).then((r) => r.json()).catch(() => null);
  Promise.all([
    fetch("data/output_AW3D30.tif").then((r) => r.arrayBuffer()),
    j("data/yala_waterways_osm.geojson"),
    j("data/yala_eastern_inflow.geojson"),
    j("data/yala_boundary.geojson"),
    j("data/yala_drainage_network_filtered.geojson"),
    j("data/yala_major_river_validated.geojson"),
    j("data/yala_roads.geojson"),                        // ถนน OSM สำหรับ burn เป็นแนวกั้นน้ำ
  ])
    .then(([buf, osm, eastern, boundary, cityDrainage, majorRiver, roads]) =>
      GeoTIFF.fromArrayBuffer(buf)
        .then((tiff) => tiff.getImage())
        .then((image) => {
          const W0 = image.getWidth(), H0 = image.getHeight();
          const bbox = image.getBoundingBox();
          return image.readRasters({ interleave: false }).then((rasters) => {
            downsampleDEM(rasters[0], W0, H0, bbox);
            if (roads) burnRoadsIntoDEM(roads);          // Fix 1: burn ถนนเป็นแนวกั้นน้ำ
            buildStudyMask(boundary);
            const majorRiverFlat = majorRiver ? flattenGeomCollection(majorRiver) : null;
            cityDrainageGlobal = cityDrainage;
            buildModel([osm, eastern, majorRiverFlat].filter(Boolean));
          });
        })
    )
    .catch((err) => {
      console.error("flood_analysis:", err);
      setStatus("⚠️ โหลด DEM ไม่สำเร็จ — ต้องเปิดผ่าน dev server (เช่น http://localhost:5173/)");
    });

  // Fix 1: burn ความสูงถนนลง DEM — ถนนทำหน้าที่เป็นแนวกั้นน้ำตามธรรมชาติ
  function burnRoadsIntoDEM(roadLayer) {
    const { W, H, elev, valid, bbox, resX, resY } = DEM;
    let burned = 0;
    (roadLayer.features || []).forEach(feat => {
      const burnM = (feat.properties && feat.properties.burn_m) || 0.3;
      const coords = feat.geometry && feat.geometry.coordinates;
      if (!coords) return;
      for (let k = 0; k < coords.length - 1; k++) {
        const [lon1, lat1] = coords[k], [lon2, lat2] = coords[k + 1];
        const x1 = (lon1 - bbox[0]) / resX, y1 = (bbox[3] - lat1) / resY;
        const x2 = (lon2 - bbox[0]) / resX, y2 = (bbox[3] - lat2) / resY;
        const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 3));
        for (let s = 0; s <= steps; s++) {
          const f = s / steps;
          // burn แนวกลางถนน + เซลล์ข้าง ๆ 1 เซลล์ (กว้างถนนประมาณ 2 เซลล์)
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const cx = Math.round(x1 + (x2 - x1) * f) + dx;
            const cy = Math.round(y1 + (y2 - y1) * f) + dy;
            if (cx < 0 || cx >= W || cy < 0 || cy >= H) continue;
            const i = cy * W + cx;
            if (!valid[i]) continue;
            elev[i] += burnM;
            burned++;
          }
        }
      }
    });
    console.log(`Road burn: elevated ${burned} cells from ${(roadLayer.features || []).length} road segments`);
  }

  // min-pool downsample (เก็บค่าต่ำสุดในแต่ละบล็อก เพื่อรักษาร่องระบายน้ำ)
  function downsampleDEM(raw, W0, H0, bbox) {
    const F = Math.max(1, Math.round(Math.max(W0, H0) / TARGET_DIM));
    const W = Math.floor(W0 / F), H = Math.floor(H0 / F);
    const elev = new Float32Array(W * H), valid = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let m = 1e9, any = 0;
      for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) {
        const e = raw[(r * F + dy) * W0 + (c * F + dx)];
        // เมืองยะลาอยู่สูง 14–80 ม.รทก. — ค่าติดลบ/ใกล้ 0 เป็น artifact ของ AW3D30 เหนือผิวน้ำ ตัดทิ้ง
        if (e > 0 && e < 9000 && isFinite(e)) { if (e < m) m = e; any = 1; }
      }
      const i = r * W + c;
      if (any) { elev[i] = m; valid[i] = 1; } else { elev[i] = 1e6; valid[i] = 0; }
    }
    DEM = { W, H, elev, valid, bbox, F,
      resX: (bbox[2] - bbox[0]) / W, resY: (bbox[3] - bbox[1]) / H };
  }

  const REGION_BUFFER = 0.025; // องศา (~2.7 กม.) รอบขอบเขตเมือง

  function buildStudyMask(boundary) {
    const { W, H, valid, bbox, resX, resY } = DEM;
    inStudy = new Uint8Array(W * H);
    inRegion = new Uint8Array(W * H);
    studyCount = 0;
    const ring = boundary && boundary.features && boundary.features[0]
      ? boundary.features[0].geometry.coordinates[0] : null;
    // กรอบ region = bbox ของขอบเขตเมือง + buffer (กันไม่ให้พื้นที่ปลายน้ำไกล ๆ ถูกนับ/วาด)
    let rw = bbox[0], re = bbox[2], rs = bbox[1], rn = bbox[3];
    if (ring) {
      rw = Math.min(...ring.map((p) => p[0])) - REGION_BUFFER;
      re = Math.max(...ring.map((p) => p[0])) + REGION_BUFFER;
      rs = Math.min(...ring.map((p) => p[1])) - REGION_BUFFER;
      rn = Math.max(...ring.map((p) => p[1])) + REGION_BUFFER;
    }
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!valid[i]) continue;
      const lon = bbox[0] + (c + 0.5) * resX, lat = bbox[3] - (r + 0.5) * resY;
      if (lon >= rw && lon <= re && lat >= rs && lat <= rn) inRegion[i] = 1;
      if (ring ? pointInRing(lon, lat, ring) : true) { inStudy[i] = 1; studyCount++; }
    }
    if (studyCount === 0) { // fallback: ใช้ทั้ง DEM
      for (let i = 0; i < W * H; i++) if (valid[i]) { inStudy[i] = 1; inRegion[i] = 1; studyCount++; }
    }
  }

  /* ----------------------------------------------------------------------- *
   * 2) source mask จากแม่น้ำ + Priority-Flood
   * ----------------------------------------------------------------------- */
  // คืน "ชุดเส้น" ของทุก geometry (LineString/MultiLineString/Polygon/MultiPolygon)
  function geomLines(geom) {
    if (!geom) return [];
    switch (geom.type) {
      case "LineString": return [geom.coordinates];
      case "MultiLineString": return geom.coordinates;
      case "Polygon": return geom.coordinates;                 // แต่ละวง
      case "MultiPolygon": return geom.coordinates.flat();      // ทุกวงของทุกโพลิกอน
      default: return [];
    }
  }

  // แปลง FeatureCollection ที่มี GeometryCollection → FeatureCollection ของ LineString เพื่อให้ buildModel อ่านได้
  function flattenGeomCollection(fc) {
    const features = [];
    (fc.features || []).forEach(feat => {
      const geom = feat.geometry;
      if (!geom) return;
      if (geom.type === 'GeometryCollection') {
        geom.geometries.forEach(g => {
          if (g.type === 'LineString' || g.type === 'MultiLineString') {
            features.push({ type: 'Feature', geometry: g, properties: feat.properties });
          }
        });
      } else {
        features.push(feat);
      }
    });
    return { type: 'FeatureCollection', features };
  }

  function buildModel(sourceLayers) {
    // บันทึก base sources เฉพาะการเรียกครั้งแรก (ก่อน cityDrainageGlobal จะถูกตั้งค่า)
    if (_baseSources === null) _baseSources = sourceLayers;
    const { W, H, elev, valid, bbox, resX, resY } = DEM;

    const source = new Uint8Array(W * H); let nSrc = 0;
    const mark = (x, r) => { if (x < 0 || x >= W || r < 0 || r >= H) return; const i = r * W + x; if (valid[i] && !source[i]) { source[i] = 1; nSrc++; } };
    // rasterize ทางน้ำทั้งหมด (แม่น้ำสังเคราะห์ + OSM จริง + ต้นน้ำตะวันออก) เป็นเซลล์ต้นน้ำ
    sourceLayers.forEach((layer) => (layer.features || []).forEach((f) => {
      geomLines(f.geometry).forEach((coords) => {
        for (let i = 0; i < coords.length - 1; i++) {
          const [lon1, lat1] = coords[i], [lon2, lat2] = coords[i + 1];
          const x1 = (lon1 - bbox[0]) / resX, y1 = (bbox[3] - lat1) / resY;
          const x2 = (lon2 - bbox[0]) / resX, y2 = (bbox[3] - lat2) / resY;
          const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
          for (let s = 0; s <= steps; s++) { const f2 = s / steps; mark(Math.floor(x1 + (x2 - x1) * f2), Math.floor(y1 + (y2 - y1) * f2)); }
        }
      });
    }));
    if (nSrc === 0) { // fallback: เซลล์ต่ำสุด 1%
      const order = []; for (let i = 0; i < W * H; i++) if (valid[i]) order.push(i);
      order.sort((a, b) => elev[a] - elev[b]);
      const k = Math.max(1, Math.floor(order.length * 0.01));
      for (let i = 0; i < k; i++) { source[order[i]] = 1; nSrc++; }
    }

    // Rain zone seeding: localized heavy rain accumulates in depressions → new flood sources
    if (rainZones.length > 0 && scenario === 'custom') {
      const degAvg = (resX + resY) / 2; // average cell size in degrees
      rainZones.forEach(zone => {
        // rainfall depth = base rain × zone multiplier × conversion factor (mm → effective meters)
        const rainDepthM = Math.max(0.5, simInputs.rainfall * zone.multiplier * 0.008);
        const zoneCellR  = Math.ceil(zone.radiusM / (degAvg * 111320));
        const zx = Math.round((zone.lon - bbox[0]) / resX);
        const zy = Math.round((bbox[3] - zone.lat) / resY);
        if (zx < 0 || zx >= W || zy < 0 || zy >= H) return;
        // find lowest elevation in zone (water collects in lowest point)
        let localMin = Infinity;
        for (let dy = -zoneCellR; dy <= zoneCellR; dy++) for (let dx = -zoneCellR; dx <= zoneCellR; dx++) {
          if (dx * dx + dy * dy > zoneCellR * zoneCellR) continue;
          const ci = (zy + dy) * W + (zx + dx);
          if (ci >= 0 && ci < W * H && valid[ci] && elev[ci] < localMin) localMin = elev[ci];
        }
        if (!isFinite(localMin)) return;
        // seed all cells within zone that rain can fill (elevation ≤ local min + rain depth)
        const threshold = localMin + rainDepthM;
        for (let dy = -zoneCellR; dy <= zoneCellR; dy++) for (let dx = -zoneCellR; dx <= zoneCellR; dx++) {
          if (dx * dx + dy * dy > zoneCellR * zoneCellR) continue;
          const ci = (zy + dy) * W + (zx + dx);
          if (ci < 0 || ci >= W * H || !valid[ci] || source[ci]) continue;
          if (elev[ci] <= threshold) { source[ci] = 1; nSrc++; }
        }
      });
    }

    arrival = new Float32Array(W * H).fill(Infinity);
    const heap = MinHeap();
    for (let i = 0; i < W * H; i++) if (source[i]) { arrival[i] = elev[i]; heap.push(elev[i], i); }
    // base0 = ระดับแม่น้ำ "ที่ตัวเมือง" (เซลล์ต้นน้ำในเขตเมือง) — ไม่ใช่จุดต่ำสุดปลายน้ำไกล ๆ
    base0 = Infinity;
    for (let i = 0; i < W * H; i++) if (source[i] && inStudy[i] && elev[i] < base0) base0 = elev[i];
    if (!isFinite(base0)) for (let i = 0; i < W * H; i++) if (source[i] && inRegion[i] && elev[i] < base0) base0 = elev[i];
    if (!isFinite(base0)) for (let i = 0; i < W * H; i++) if (source[i] && elev[i] < base0) base0 = elev[i];
    const NB = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
    while (heap.size()) {
      const [L, c] = heap.pop();
      if (L > arrival[c]) continue;
      const cx = c % W;
      for (let d = 0; d < 8; d++) {
        const nb = c + NB[d];
        if (nb < 0 || nb >= W * H || !valid[nb]) continue;
        if (Math.abs((nb % W) - cx) > 1) continue; // กัน wrap ขอบ
        const newL = Math.max(L, elev[nb]);
        if (newL < arrival[nb]) { arrival[nb] = newL; heap.push(newL, nb); }
      }
    }

    buildD8();          // compute steepest-descent direction for each cell
    particles = null;   // reset so particles respawn in new flood extent
    floodedCellList = null;
    cachedFlood = null;
    stopWaveAnim();
    computeLevels();

    // ลบ overlay เดิมก่อน (กันรายการซ้ำสะสมทุกครั้งที่ rebuild/กดจำลอง)
    [floodOverlay, arrowOverlay, orderOverlay].forEach(function (o) {
      if (!o) return;
      if (map.hasLayer(o)) map.removeLayer(o);
      if (typeof layerControl !== "undefined") layerControl.removeLayer(o);
    });
    floodOverlay = L.imageOverlay("", bboxToLatLng(bbox), { opacity: 0.8, interactive: false }).addTo(map);
    arrowOverlay = L.imageOverlay(renderArrows(), bboxToLatLng(bbox), { opacity: 0.85 }); // ปิดตอนโหลด — เปิดเองได้ในกล่องเลเยอร์
    orderOverlay = L.imageOverlay(renderOrder(), bboxToLatLng(bbox), { opacity: 0.72 });
    if (typeof layerControl !== "undefined") {
      layerControl.addOverlay(floodOverlay, "การแพร่ของน้ำท่วม (เคลื่อนไหว)");
      layerControl.addOverlay(arrowOverlay, "ทิศทางการไหล (drainage)");
      layerControl.addOverlay(orderOverlay, "ลำดับการท่วม (ก่อน→หลัง)");
    }

    badgeText();
    setStatus(`พร้อมแล้ว — ต้นน้ำ: แม่น้ำปัตตานี (ตะวันตก) + ทางน้ำจริง OSM + ต้นน้ำตะวันออก (สะเตงนอก/บึงแบเมาะ) · กริด DEM ${W}×${H} (~${Math.round(resX * 111320 * Math.cos(6.5 * Math.PI / 180))} ม.) · เมือง ${studyCount.toLocaleString()} เซลล์`);
    render();
  }

  let _baseSources = null; // เก็บ river-only seed layers สำหรับ rebuild

  // เรียกเมื่อสลับ scenario: rebuild arrival map ด้วย seed ที่เหมาะสม
  function rebuildForScenario() {
    if (!_baseSources) return;
    // รวม drainage/sewer เป็น flood source เมื่อวิกฤต (น้ำย้อนจากท่อระบาย)
    const useDrainage = scenario === 'high' ||
      (scenario === 'custom' && (simInputs.damLevel >= 80 || computeFloodIntensity() >= 0.65));
    if (useDrainage && cityDrainageGlobal) {
      buildModel([..._baseSources, cityDrainageGlobal].filter(Boolean));
    } else {
      buildModel(_baseSources.filter(Boolean));
    }
  }

  // กำหนด surfaceMax ตามสถานการณ์ + เตรียม sortedReach สำหรับ pacing แบบลำดับการท่วม
  function computeLevels() {
    if (!arrival) return; // กันกรณีเรียกก่อนโมเดลพร้อม
    // surfaceMax = ระดับน้ำที่ทำให้เซลล์เมือง pct% ถูกท่วม (percentile ของ arrival ในเขตเมือง)
    const cityArr = [];
    for (let i = 0; i < arrival.length; i++) if (inStudy[i] && isFinite(arrival[i])) cityArr.push(arrival[i]);
    cityArr.sort((a, b) => a - b);
    surfaceMax = cityArr.length
      ? cityArr[Math.min(cityArr.length - 1, Math.floor(SCENARIOS[scenario].pct * (cityArr.length - 1)))]
      : base0 + 5;
    // sortedReach = arrival ในเขต region ที่ <= surfaceMax (สำหรับ pacing แอนิเมชันให้ลื่น)
    const arr = [];
    for (let i = 0; i < arrival.length; i++) if (inRegion[i] && isFinite(arrival[i]) && arrival[i] <= surfaceMax) arr.push(arrival[i]);
    arr.sort((a, b) => a - b);
    sortedReach = Float32Array.from(arr);
  }

  /* ----------------------------------------------------------------------- *
   * Simulation input logic
   * ----------------------------------------------------------------------- */

  // คำนวณ flood intensity [0–1] จาก rainfall + dam level
  function computeFloodIntensity() {
    // แม่น้ำเป็นตัวขับหลัก (ล้นตลิ่ง) · ฝน+เขื่อนเสริม — ให้สอดคล้องกับโมเดล 3D
    const rainNorm  = Math.min(simInputs.rainfall / 80, 1); // 80 mm/hr = peak
    const damNorm   = Math.min(simInputs.damLevel  / 100, 1);
    const riverNorm = Math.min((simInputs.river != null ? simInputs.river : 50) / 100, 1);
    return Math.min(riverNorm * 0.45 + rainNorm * 0.35 + damNorm * 0.20, 1);
  }

  function scenarioNameForIntensity(intensity) {
    if (intensity < 0.20) return "ปกติ (จำลองสถานการณ์)";
    if (intensity < 0.45) return "เฝ้าระวัง (จำลองสถานการณ์)";
    if (intensity < 0.70) return "เตือนภัย — น้ำหลากปานกลาง (จำลอง)";
    return "วิกฤต — น้ำหลากรุนแรง (จำลอง)";
  }

  // ===== เครื่องยนต์เดียวกับ 3D: flood_response.json (input→ระดับน้ำ→พื้นที่/ลึก) =====
  // โหลดครั้งเดียว → 2D และ 3D ใช้สูตร + เส้นโค้งตอบสนองตัวเดียวกัน → ตัวเลขตรงกัน
  var FR = null, frBase = 0, frOnset = 0, customStage = 0;
  fetch('data/flood_response.json').then(function (r) { return r.json(); })
    .then(function (d) { FR = d; frBase = d.base_stage_m; frOnset = d.onset_stage_m; try { updateVerdict2D(); } catch (e) {} })
    .catch(function () {});
  function frStageOf(rain, river, dam) {
    if (!FR) return null;
    var M = FR.mapping, onsetRise = FR.onset_stage_m - FR.base_stage_m;
    var rr = (river <= M.river_bankfull_pct)
      ? onsetRise * (river / M.river_bankfull_pct)
      : onsetRise + (river - M.river_bankfull_pct) / (100 - M.river_bankfull_pct) * M.river_extra_m;
    var rn = M.rain_max_m * Math.pow(Math.min(1, Math.max(0, rain) / 100), 0.85);
    var dm = (dam <= M.dam_onset_pct) ? 0 : M.dam_max_m * (dam - M.dam_onset_pct) / (100 - M.dam_onset_pct);
    return Math.min(FR.base_stage_m + rr + rn + dm, FR.base_stage_m + FR.event_rise_m + 0.5);
  }
  function frCurveAt(stage) {
    var cv = FR && FR.curve; if (!cv || !cv.length) return null;
    if (stage <= cv[0].stage) return cv[0];
    for (var i = 1; i < cv.length; i++) {
      if (stage <= cv[i].stage) {
        var lo = cv[i - 1], hi = cv[i], k = (stage - lo.stage) / (hi.stage - lo.stage + 1e-9);
        return {
          area_pct: lo.area_pct + (hi.area_pct - lo.area_pct) * k,
          land_pct: lo.land_pct + (hi.land_pct - lo.land_pct) * k,
          depth_median: lo.depth_median + (hi.depth_median - lo.depth_median) * k,
          depth_p95: lo.depth_p95 + (hi.depth_p95 - lo.depth_p95) * k
        };
      }
    }
    return cv[cv.length - 1];
  }
  function scenarioNameForStage(stage) {
    if (!FR) return "จำลองตามผู้ใช้กำหนด";
    if (stage < frOnset - 0.4) return "ปกติ — ยังไม่ท่วม (จำลอง)";
    if (stage < frOnset)       return "เฝ้าระวัง — ใกล้ท่วม (จำลอง)";
    var c = frCurveAt(stage), lp = c ? c.land_pct : 0;
    if (lp < 4)  return "เตือนภัย — เริ่มท่วม (จำลอง)";
    if (lp < 12) return "เตือนภัย — น้ำท่วมปานกลาง (จำลอง)";
    return "วิกฤต — น้ำท่วมรุนแรง (จำลอง)";
  }

  // หา "ค่าต่ำสุดของตัวขับหนึ่ง" ที่ทำให้เริ่มท่วม (ตรึงอีกสองตัว) — เหมือนหน้า 3D
  function threshFor(driver, rain, river, dam) {
    if (!FR) return null;
    for (var v = 0; v <= 200; v += 0.5) {
      var a = { rain: rain, river: river, dam: dam }; a[driver] = v;
      if (frStageOf(a.rain, a.river, a.dam) >= frOnset - 1e-6) return v;
    }
    return null;
  }

  // การ์ดคำตัดสันน้ำท่วม (โครงสร้าง/ข้อความเดียวกับหน้า 3D)
  function updateVerdict2D() {
    var elVer = document.getElementById('verdict'), elTh = document.getElementById('vThr');
    if (!elVer || !FR) return;
    var rain = simInputs.rainfall, river = simInputs.river, dam = (simInputs.damLevel != null ? simInputs.damLevel : 50);
    var st = frStageOf(rain, river, dam); if (st == null) return;
    var c = frCurveAt(st) || { land_pct: 0, depth_median: 0 };
    var margin = st - frOnset;
    if (margin >= 0) {
      var sev = c.land_pct >= 12 ? 'รุนแรง' : (c.land_pct >= 4 ? 'ปานกลาง' : 'เริ่มท่วม');
      elVer.className = 'verdict v-flood';
      elVer.innerHTML = '<i class="ti ti-alert-triangle"></i> <span>น้ำท่วม (' + sev + ') — ลึกทั่วไป <b>' + c.depth_median.toFixed(2) + ' ม.</b></span>';
      if (elTh) elTh.innerHTML = 'เกินเกณฑ์เริ่มท่วมมา <b>' + margin.toFixed(2) + ' ม.</b> · ระดับน้ำในเมือง ~<b>+' + st.toFixed(1) + ' ม.รทก</b>';
    } else {
      var near = margin > -0.4;
      elVer.className = 'verdict ' + (near ? 'v-watch' : 'v-safe');
      elVer.innerHTML = '<i class="ti ti-' + (near ? 'alert-circle' : 'shield-check') + '"></i> <span>' +
        (near ? 'เฝ้าระวัง — ใกล้ท่วม' : 'ยังไม่ท่วม') + ' (อีก <b>' + (-margin).toFixed(2) + ' ม.</b> ถึงเกณฑ์)</span>';
      var tR = threshFor('river', rain, river, dam), tN = threshFor('rain', rain, river, dam), tD = threshFor('dam', rain, river, dam);
      var parts = [];
      if (tR != null && tR <= 100) parts.push('แม่น้ำ ≥ <b>' + Math.round(tR) + '%</b>');
      if (tN != null && tN <= 200) parts.push('ฝน ≥ <b>' + Math.round(tN) + ' มม./ชม.</b>');
      if (tD != null && tD <= 100) parts.push('เขื่อน ≥ <b>' + Math.round(tD) + '%</b>');
      if (elTh) elTh.innerHTML = parts.length ? ('เริ่มท่วมเมื่อ (ที่ค่าอื่นปัจจุบัน): ' + parts.join(' หรือ ')) : '';
    }
  }

  function applySimInputs() {
    const intensity = computeFloodIntensity();
    const tMult = simLongRunHours / 24; // 24h=1× · 3วัน · 7วัน
    // ===== ระดับน้ำ (stage) จากสูตรเดียวกับ 3D — 24 ชม. = ตรงกับ 3D เป๊ะ · นานขึ้น = สูงขึ้นเล็กน้อย =====
    const st0 = frStageOf(simInputs.rainfall, simInputs.river, (simInputs.damLevel != null ? simInputs.damLevel : 50));
    if (st0 != null && FR) {
      customStage = st0 + (tMult - 1) * 0.25 * (frOnset - frBase);   // 24h → +0
      const cv = frCurveAt(customStage);
      SCENARIOS.custom.pct      = Math.min(0.95, Math.max(0, (cv ? cv.land_pct : 0) / 100));
      SCENARIOS.custom.depthRef = Math.max(0.05, cv ? cv.depth_p95 : 0.3);
      SCENARIOS.custom.name     = scenarioNameForStage(customStage);
    } else {   // fallback ถ้ายังโหลด flood_response ไม่เสร็จ
      customStage = 0;
      SCENARIOS.custom.pct      = Math.min(0.92, (0.15 + intensity * 0.70) * (1 + (tMult - 1) * 0.25));
      SCENARIOS.custom.depthRef = Math.min(2.8,  (0.30 + intensity * 1.70) * (1 + (tMult - 1) * 0.18));
      SCENARIOS.custom.name     = scenarioNameForIntensity(intensity);
    }

    const prevScenario  = scenario;
    const usesDrainage  = simInputs.damLevel >= 80 || intensity >= 0.65;
    scenario = 'custom';
    t = 0;
    if (sld) sld.value = 0;

    if (!arrival) {
      badgeText();
      updateSimUI(intensity);
      return;
    }

    if (usesDrainage !== _lastSimDrainage || prevScenario !== 'custom') {
      _lastSimDrainage = usesDrainage;
      rebuildForScenario(); // calls buildModel → computeLevels + render internally
    } else {
      computeLevels();
      if (orderOverlay) orderOverlay.setUrl(renderOrder());
      badgeText();
      render();
    }
    updateSimUI(intensity);
    playing = true; setPlayIcon(); startAnim();
  }

  // อัปเดตน้ำท่วมบนแผนที่ "ทันที" ตามสไลเดอร์ (ไม่เริ่มแอนิเมชันใหม่)
  // → แผนที่ตรงกับค่าที่ตั้งเสมอ · ตั้ง 0 = น้ำหาย (แก้บั๊กแผนที่ค้างผลเก่า)
  function previewSim() {
    if (!arrival || !FR) return;
    const tMult = simLongRunHours / 24;
    const st0 = frStageOf(simInputs.rainfall, simInputs.river, (simInputs.damLevel != null ? simInputs.damLevel : 50));
    if (st0 == null) return;
    customStage = st0 + (tMult - 1) * 0.25 * (frOnset - frBase);
    const cv = frCurveAt(customStage);
    SCENARIOS.custom.pct      = Math.min(0.95, Math.max(0, (cv ? cv.land_pct : 0) / 100));
    SCENARIOS.custom.depthRef = Math.max(0.05, cv ? cv.depth_p95 : 0.3);
    SCENARIOS.custom.name     = scenarioNameForStage(customStage);
    scenario = 'custom';
    if (!playing) { t = 1; if (sld) sld.value = 100; }   // ไม่ได้เล่นอยู่ → โชว์ผลเต็มของค่าปัจจุบัน
    computeLevels();
    badgeText();
    render();
  }
  let _previewTimer = null;
  function schedulePreview() { clearTimeout(_previewTimer); _previewTimer = setTimeout(previewSim, 140); }

  // อัปเดตกล่อง "สถานะแม่น้ำปัตตานี" (แถบ+ป้าย) ให้ตรงกับค่าสไลเดอร์แม่น้ำ
  function updateRiverBox(pct) {
    pct = Math.round(pct);
    const riverBar   = document.getElementById('simRiverBar');
    const riverLabel = document.getElementById('simRiverLevel');
    if (riverBar) riverBar.style.width = pct + '%';
    const rlabel =
      pct < 42 ? 'ต่ำ — ปลอดภัย'      :
      pct < 65 ? 'ปกติ'                 :
      pct < 82 ? 'สูงกว่าปกติ'          :
      pct < 93 ? 'ใกล้ระดับวิกฤต ⚠'   : 'ล้นตลิ่ง ⚠';
    if (riverLabel) riverLabel.textContent = rlabel + ' (' + pct + '%)';
  }

  function updateSimUI(intensity) {
    updateRiverBox(simInputs.river != null ? simInputs.river : 50);
    updateVerdict2D();   // การ์ดคำตัดสันแบบเดียวกับ 3D
  }

  /* ----------------------------------------------------------------------- *
   * Rain zone management
   * ----------------------------------------------------------------------- */

  function addRainZone(lat, lon) {
    const zone = { id: ++_rainZoneIdCounter, lat, lon, radiusM: rainZoneRadiusM, multiplier: rainZoneMultiplier };
    if (typeof map !== 'undefined') {
      zone.circle = L.circle([lat, lon], {
        radius: zone.radiusM, color: '#1d4ed8', fillColor: '#60a5fa',
        fillOpacity: 0.18, weight: 2, dashArray: '6 4',
      }).addTo(map);
      zone.circle.bindPopup(
        '<div style="font-family:Sarabun,sans-serif;font-size:12px;">' +
        '<b>ฝนตกหนัก ×' + zone.multiplier + '</b><br>' +
        'รัศมี ' + (zone.radiusM / 1000).toFixed(1) + ' กม.<br>' +
        '<button onclick="window.removeRainZone(' + zone.id + ')" ' +
        'style="margin-top:6px;padding:3px 12px;background:#dc2626;color:white;border:none;border-radius:5px;cursor:pointer;font-family:Sarabun,sans-serif;">ลบออก</button>' +
        '</div>'
      );
    }
    rainZones.push(zone);
    updateRainZoneList();
  }

  window.removeRainZone = function (id) {
    const idx = rainZones.findIndex(z => z.id === id);
    if (idx === -1) return;
    if (rainZones[idx].circle && typeof map !== 'undefined') map.removeLayer(rainZones[idx].circle);
    rainZones.splice(idx, 1);
    updateRainZoneList();
    if (typeof map !== 'undefined') map.closePopup();
  };

  function updateRainZoneList() {
    const listEl   = document.getElementById('simRainZoneList');
    const statusEl = document.getElementById('simRainZoneStatus');
    if (!listEl) return;
    if (rainZones.length === 0) {
      listEl.innerHTML = '';
      if (statusEl) statusEl.textContent = 'ยังไม่มีพื้นที่กำหนด — กด "วาดบนแผนที่" แล้วคลิกบนแผนที่';
      return;
    }
    if (statusEl) statusEl.textContent = 'กำหนดแล้ว ' + rainZones.length + ' พื้นที่ — กด "เริ่มจำลอง" เพื่ออัปเดต';
    listEl.innerHTML = rainZones.map((z, i) =>
      '<li class="sim-rain-zone-item">' +
      '<i class="ti ti-cloud-rain" style="color:#3b82f6;font-size:11px;"></i>' +
      ' พื้นที่ ' + (i + 1) + ': ×' + z.multiplier + ' รัศมี ' + (z.radiusM / 1000).toFixed(1) + ' กม.' +
      '<button class="btn-rain-remove" onclick="window.removeRainZone(' + z.id + ')">' +
      '<i class="ti ti-x" style="font-size:10px;"></i></button>' +
      '</li>'
    ).join('');
  }

  function toggleRainDraw() {
    rainDrawMode = !rainDrawMode;
    const btn   = document.getElementById('simRainDrawToggle');
    const icon  = document.getElementById('rainDrawIcon');
    const mapEl = document.getElementById('map');
    if (rainDrawMode) {
      if (btn)   { btn.classList.add('active'); }
      if (icon)  icon.className = 'ti ti-pencil-off';
      if (mapEl) mapEl.style.cursor = 'crosshair';
    } else {
      if (btn)   { btn.classList.remove('active'); }
      if (icon)  icon.className = 'ti ti-pencil';
      if (mapEl) mapEl.style.cursor = '';
    }
  }

  /* ----------------------------------------------------------------------- *
   * 4) Wave ripple + flow particle animation
   * ----------------------------------------------------------------------- */

  function buildD8() {
    if (!DEM) return;
    const { W, H, elev, valid } = DEM;
    d8 = new Int8Array(W * H).fill(-1);
    for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) {
      const i = r * W + c;
      if (!valid[i]) continue;
      let best = -1, bestDrop = 0;
      for (let d = 0; d < 8; d++) {
        const ni = (r + D8_DY[d]) * W + (c + D8_DX[d]);
        if (ni < 0 || ni >= W * H || !valid[ni]) continue;
        const drop = (elev[i] - elev[ni]) / Math.hypot(D8_DX[d], D8_DY[d]);
        if (drop > bestDrop) { bestDrop = drop; best = d; }
      }
      d8[i] = best;
    }
    // Flow accumulation: upstream cell count for each cell.
    // High value = main drainage corridor = where flood water converges on its way to the river.
    // Used during drain mode to show WHERE water flows (for แก้มลิง placement analysis).
    const n = W * H;
    _flowAcc = new Float32Array(n).fill(1);
    // Process cells from highest to lowest elevation (upstream → downstream)
    const order = Array.from({length: n}, (_, i) => i)
      .sort((a, b) => elev[b] - elev[a]);
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const dir = d8[i];
      if (dir < 0) continue;
      const r = Math.floor(i / W), c = i % W;
      const nr = r + D8_DY[dir], nc = c + D8_DX[dir];
      if (nr >= 0 && nr < H && nc >= 0 && nc < W) {
        _flowAcc[nr * W + nc] += _flowAcc[i];
      }
    }
    _maxFlowAcc = 1;
    for (let i = 0; i < n; i++) if (_flowAcc[i] > _maxFlowAcc) _maxFlowAcc = _flowAcc[i];
  }

  function initParticles() {
    particles = [];
    for (let n = 0; n < N_PARTICLES; n++) particles.push(spawnParticle());
  }

  function spawnParticle() {
    if (!floodedCellList || !floodedCellList.length) return null;
    let ci;
    if (draining && _flowAcc && Math.random() < 0.75) {
      // During drain: 75% of particles spawn on drainage corridors so they
      // visibly stream toward the river (shows where แก้มลิง would help most)
      const thresh = _maxFlowAcc * 0.01;
      let tries = 0;
      do {
        ci = floodedCellList[Math.floor(Math.random() * floodedCellList.length)];
        tries++;
      } while (_flowAcc[ci] < thresh && tries < 30);
    } else {
      ci = floodedCellList[Math.floor(Math.random() * floodedCellList.length)];
    }
    return {
      x: (ci % DEM.W) + (Math.random() - 0.5),
      y: Math.floor(ci / DEM.W) + (Math.random() - 0.5),
      age: Math.random() * 0.3,
      speed: draining ? (0.7 + Math.random() * 0.9) : (0.4 + Math.random() * 0.7),
    };
  }

  function isFloodedAt(i) {
    return !!(cachedFlood && arrival && inRegion && inRegion[i] &&
              isFinite(arrival[i]) && arrival[i] <= cachedFlood.surface);
  }

  function startWaveAnim() {
    if (_waveAnimId) return;
    _lastWaveTs = performance.now();
    _waveAnimId = requestAnimationFrame(waveAnimLoop);
  }

  function stopWaveAnim() {
    if (_waveAnimId) { cancelAnimationFrame(_waveAnimId); _waveAnimId = null; }
  }

  function waveAnimLoop(ts) {
    if (!DEM || !floodOverlay || !cachedFlood) { _waveAnimId = null; return; }
    const dt = Math.min(0.08, (ts - _lastWaveTs) / 1000);
    _lastWaveTs = ts;
    waveT += dt * 1.6;
    renderWaveFrame(dt);
    _waveAnimId = requestAnimationFrame(waveAnimLoop);
  }

  function renderWaveFrame(dt) {
    if (!floodedCellList || !floodedCellList.length || !cachedFlood) return;
    const { W, H } = DEM;

    // Reuse canvas + ImageData across frames (avoid GC pressure)
    if (!_waveCv || _waveCv.width !== W || _waveCv.height !== H) {
      _waveCv = document.createElement('canvas');
      _waveCv.width = W; _waveCv.height = H;
      _waveCx = _waveCv.getContext('2d');
      _waveImg = _waveCx.createImageData(W, H);
    }
    const pxData = _waveImg.data;

    // Clear alpha channel only (avoids full array zero-fill each frame)
    for (let i = 3; i < pxData.length; i += 4) pxData[i] = 0;

    // ── Pass 1: Flood pixels with wave shimmer + flood-front gradient ────────
    // Flood-front gradient: cells that JUST reached by water (arrival ≈ current surface)
    // appear at low opacity, then ramp to full opacity as more water flows in.
    // This creates a visible "leading edge" so you can see WHERE water is actively
    // arriving from — instead of cells appearing out of nowhere at full opacity.
    const curSurface = cachedFlood.surface;
    const arrivalSpan = Math.max(0.001, surfaceMax - base0);
    const depths = cachedFlood.depths;
    for (let k = 0; k < floodedCellList.length; k++) {
      const ci = floodedCellList[k];
      const calibDepth = depths[k];
      const col = ci % W, row = Math.floor(ci / W);
      const dd = Math.min(calibDepth / 2.0, 1);

      const wx = col * 0.32 + waveT * 1.25;
      const wy = row * 0.27 - waveT * 0.88;
      const wave = Math.sin(wx) * 0.55 +
                   Math.sin(wy + waveT * 0.38) * 0.28 +
                   Math.sin((wx + wy) * 0.55 - waveT * 0.5) * 0.17;
      const sh = Math.round(wave * 26);

      // recency: 0 = cell just flooded this tick, 1 = flooded well before current surface
      const recency = arrival ? (curSurface - arrival[ci]) / arrivalSpan : 1;
      // Fade in over the first 9% of the arrival span: newly flooded cells start at 12%
      // opacity and quickly rise to full — creates a smooth "wave front" not a hard edge
      const frontFade = Math.min(1, Math.max(0.12, recency / 0.09));

      const p = ci * 4;
      pxData[p]     = Math.max(0, Math.min(255, Math.round(126 + (12  - 126) * dd) + Math.round(sh * 0.3)));
      pxData[p + 1] = Math.max(0, Math.min(255, Math.round(200 + (63  - 200) * dd) + Math.round(sh * 0.15)));
      pxData[p + 2] = Math.max(0, Math.min(255, Math.round(230 + (110 - 230) * dd) + sh));
      pxData[p + 3] = Math.round(
        Math.max(40, Math.min(255, Math.round(150 + 95 * dd) + Math.round(sh * 0.4))) * frontFade
      );
    }

    // ── Pass 2a (flood only): Flood-front highlight ─────────────────────────
    // Cells at the leading edge of the flood get a bright cyan-white shimmer so
    // the user can clearly see WHICH DIRECTION the water is advancing from.
    // "ถนนนัดโต๊ะโมง2 ห่างจากแม่น้ำ แต่น้ำมาได้ยังไง?" → ดูแนวหน้า (bright edge)
    // ซึ่งจะเห็นว่ามันต่อเนื่องมาจากแม่น้ำหรือจากทิศทางใด
    if (!draining && arrival) {
      const frontThresh = arrivalSpan * 0.06; // cells flooded within last 6% of span = "front"
      const frontPulse = 0.60 + 0.40 * Math.sin(waveT * 3.5);
      for (let k = 0; k < floodedCellList.length; k++) {
        const ci = floodedCellList[k];
        const gap = curSurface - arrival[ci]; // how recently this cell flooded
        if (gap > frontThresh) continue;     // already deep in flood, skip
        const frontNorm = 1 - gap / frontThresh; // 1 = just flooded, 0 = edge of window
        const a = Math.round(frontNorm * frontPulse * 200);
        if (a < 4) continue;
        const p = ci * 4;
        // Bright cyan-white: visually distinct from normal blue flood
        pxData[p]     = Math.round(160 + 80 * frontNorm);
        pxData[p + 1] = Math.round(230 + 20 * frontNorm);
        pxData[p + 2] = 255;
        pxData[p + 3] = Math.min(255, a);
      }
    }

    // ── Pass 2b (drain only): Drainage corridor overlay ─────────────────────
    // Cells with high flow accumulation = natural channels where ALL the flood water
    // converges on its way back to the river. Amber overlay = "water is flowing HERE".
    // This shows WHERE to place แก้มลิง: wide amber corridors passing through the city
    // = the highest-impact retention points.
    if (draining && _flowAcc) {
      const thresh = _maxFlowAcc * 0.03; // top ~3% = main drainage network
      const pulse = 0.70 + 0.30 * Math.sin(waveT * 2.8);
      for (let k = 0; k < floodedCellList.length; k++) {
        const ci = floodedCellList[k];
        const acc = _flowAcc[ci];
        if (acc < thresh) continue;
        const accNorm = Math.min(1, (acc - thresh) / (thresh * 6));
        const a = Math.round((0.55 + 0.40 * accNorm) * pulse * 255);
        if (a < 4) continue;
        const p = ci * 4;
        pxData[p]     = 255;
        pxData[p + 1] = Math.round(175 - 80 * accNorm); // amber → deep orange
        pxData[p + 2] = Math.round(30  - 20 * accNorm);
        pxData[p + 3] = Math.min(255, a);
      }
    }

    _waveCx.putImageData(_waveImg, 0, 0);

    // ── Flow particles (streaks following D8 steepest-descent) ───────────────
    // Flood = cool blue-white (water spreading outward from river)
    // Drain = fast warm amber (water streaming along corridors back to river)
    //
    // During drain, particles are allowed to continue PAST the current flood boundary
    // for a short time — this shows water physically flowing away from the area,
    // not disappearing into the ground.
    if (particles && d8) {
      _waveCx.save();
      _waveCx.lineCap = 'round';
      _waveCx.lineWidth = draining ? 1.8 : 1.2;
      for (let n = 0; n < particles.length; n++) {
        const p = particles[n];
        if (!p) { particles[n] = spawnParticle(); continue; }

        p.age += dt * 0.52 * p.speed;
        if (p.age >= 1) { particles[n] = spawnParticle(); continue; }

        const cx = Math.floor(p.x), cy = Math.floor(p.y);
        const ci = cy * W + cx;
        if (cx < 1 || cx >= W - 1 || cy < 1 || cy >= H - 1) {
          particles[n] = spawnParticle(); continue;
        }

        const inFlood = isFloodedAt(ci);
        if (!draining && !inFlood) { particles[n] = spawnParticle(); continue; }
        // Drain: let particles continue past flood boundary (water keeps flowing to river
        // even after an area has drained). Age them faster so they fade quickly.
        if (draining && !inFlood) p.age += dt * 2.2;

        const dir = d8[ci];
        if (dir < 0) { if (!inFlood) particles[n] = spawnParticle(); continue; }

        const alpha = Math.sin(p.age * Math.PI) * 0.72;
        const moveSpeed = draining ? 0.55 : 0.20;
        const tailLen   = draining ? 4.8 * p.speed : 2.6 * p.speed;
        _waveCx.beginPath();
        _waveCx.moveTo(p.x - D8_DX[dir] * tailLen, p.y - D8_DY[dir] * tailLen);
        _waveCx.lineTo(p.x, p.y);
        _waveCx.strokeStyle = draining
          ? 'rgba(255,195,60,' + alpha.toFixed(2) + ')'
          : 'rgba(210,238,255,' + alpha.toFixed(2) + ')';
        _waveCx.stroke();

        p.x += D8_DX[dir] * moveSpeed * p.speed;
        p.y += D8_DY[dir] * moveSpeed * p.speed;
      }
      _waveCx.restore();
    }

    if (floodOverlay) floodOverlay.setUrl(_waveCv.toDataURL());
  }

  // ระดับน้ำผิว ณ เวลา t : เร่งให้เซลล์ค่อย ๆ ถูกเปิดเผยตามลำดับการท่วม (ภาพแผ่ลื่น)
  function surfaceAt(tt) {
    if (!sortedReach || !sortedReach.length) return base0 + tt * (surfaceMax - base0);
    const idx = Math.min(sortedReach.length - 1, Math.floor(tt * (sortedReach.length - 1)));
    return sortedReach[idx];
  }

  /* ----------------------------------------------------------------------- *
   * 3) เรนเดอร์ความลึก ณ เวลา t
   * ----------------------------------------------------------------------- */
  function render() {
    if (!DEM || !arrival) return;
    const { W, H, elev } = DEM;
    const surface = surfaceAt(t);

    let flooded = 0;
    const cityDepths = [];
    for (let i = 0; i < W * H; i++) {
      if (inRegion[i] && isFinite(arrival[i]) && arrival[i] <= surface) {
        const depth = surface - elev[i];
        if (depth > 0.05) {
          cityDepths.push({ i, depth });
          if (inStudy[i]) flooded++;
        }
      }
    }

    const depthRef = SCENARIOS[scenario].depthRef;
    const rawDepths = cityDepths.map(d => d.depth).sort((a, b) => a - b);
    const rawP90 = rawDepths.length > 10 ? rawDepths[Math.floor(rawDepths.length * 0.9)] : depthRef;
    const depthScale = Math.min(4, depthRef / Math.max(0.05, rawP90));

    // Cache flood data → wave animation loop picks it up each rAF frame
    const cellIdxArr   = new Int32Array(cityDepths.length);
    const calibDepthArr = new Float32Array(cityDepths.length);
    for (let k = 0; k < cityDepths.length; k++) {
      cellIdxArr[k]    = cityDepths[k].i;
      calibDepthArr[k] = cityDepths[k].depth * depthScale;
    }
    floodedCellList = cellIdxArr;
    cachedFlood = { surface, depths: calibDepthArr, draining };

    if (floodedCellList.length > 0) {
      if (!particles) initParticles();
      startWaveAnim();
    } else {
      stopWaveAnim();
      if (floodOverlay) floodOverlay.setUrl('');
    }

    const calibDepths = rawDepths.map(d => d * depthScale);
    const medDepth = calibDepths.length ? calibDepths[calibDepths.length >> 1] : 0;
    // แสดงพื้นที่ท่วม%/ลึก จาก "เส้นโค้งตอบสนองเดียวกับ 3D" (ไต่ตามไทม์ไลน์ t) → ตัวเลขตรงกับ 3D
    if (scenario === 'custom' && FR && customStage > 0) {
      const stageNow = frBase + t * (customStage - frBase);
      const m = frCurveAt(stageNow);
      if (elArea)  elArea.textContent  = (m ? m.area_pct : 0).toFixed(1);
      if (elDepth) elDepth.textContent = (m ? m.depth_median : 0).toFixed(2);
    } else {
      if (elArea)  elArea.textContent  = (studyCount ? flooded / studyCount * 100 : 0).toFixed(1);
      if (elDepth) elDepth.textContent = medDepth.toFixed(2);
    }
    if (elBar) elBar.style.width = Math.round(t * 100) + "%";
    // Fix 2 + Fix 6: timeline จริง — spread hours ตามสถานการณ์ + lag จากเขื่อนบางลาง
    const SPREAD_HOURS = { base: 12, high: 6, custom: simLongRunHours };
    const BANGLONG_LAG_H = 9; // เขื่อนบางลาง → ยะลา ~80 กม. ที่ ~2.5 ม./วิ ≈ 9 ชม.
    const spreadH = Math.round(t * (SPREAD_HOURS[scenario] || 24));
    if (tlab) {
      if (scenario === 'high' && latestRainfall !== null) {
        tlab.textContent = "ชม. +" + (BANGLONG_LAG_H + spreadH) + " หลังระบาย";
      } else {
        tlab.textContent = "ชม. +" + spreadH + " หลังล้นตลิ่ง";
      }
    }
  }

  // เลเยอร์ "ลำดับการท่วม" (คงที่): แดง=ก่อน → ฟ้า=หลัง
  function renderOrder() {
    const { W, H } = DEM;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const cx = cv.getContext("2d");
    const img = cx.createImageData(W, H); const a = img.data;
    const span = Math.max(0.001, surfaceMax - base0);
    const stops = [[239, 68, 68], [249, 115, 22], [234, 179, 8], [34, 197, 94], [14, 165, 233]];
    for (let i = 0; i < W * H; i++) {
      if (inRegion[i] && isFinite(arrival[i]) && arrival[i] <= surfaceMax) {
        const f = Math.min(1, Math.max(0, (arrival[i] - base0) / span));
        const x = f * (stops.length - 1), i0 = Math.floor(x), i1 = Math.min(stops.length - 1, i0 + 1), ft = x - i0, p = i * 4;
        a[p]     = Math.round(stops[i0][0] + (stops[i1][0] - stops[i0][0]) * ft);
        a[p + 1] = Math.round(stops[i0][1] + (stops[i1][1] - stops[i0][1]) * ft);
        a[p + 2] = Math.round(stops[i0][2] + (stops[i1][2] - stops[i0][2]) * ft);
        a[p + 3] = 205;
      }
    }
    cx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  // เลเยอร์ลูกศรทิศทางการไหล (D8 steepest descent) เฉพาะในเขตเมือง
  function renderArrows() {
    const { W, H, elev, valid } = DEM, S = ARROW_SCALE;
    const cv = document.createElement("canvas"); cv.width = W * S; cv.height = H * S;
    const ctx = cv.getContext("2d");
    ctx.strokeStyle = "rgba(30,41,59,0.55)"; ctx.fillStyle = "rgba(30,41,59,0.55)"; ctx.lineWidth = 1.3;
    const STEP = 7;
    for (let r = STEP; r < H - STEP; r += STEP) for (let c = STEP; c < W - STEP; c += STEP) {
      const i = r * W + c;
      if (!valid[i] || !inStudy[i]) continue;
      let bdx = 0, bdy = 0, bdrop = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const ni = (r + dy) * W + (c + dx);
        if (ni < 0 || ni >= W * H || !valid[ni]) continue;
        const drop = (elev[i] - elev[ni]) / Math.hypot(dx, dy);
        if (drop > bdrop) { bdrop = drop; bdx = dx; bdy = dy; }
      }
      if (bdrop <= 0) continue;
      const len = Math.hypot(bdx, bdy), ux = bdx / len, uy = bdy / len;
      const x0 = (c + 0.5) * S, y0 = (r + 0.5) * S, AL = STEP * S * 0.5;
      const x1 = x0 + ux * AL, y1 = y0 + uy * AL, ang = Math.atan2(uy, ux), ah = 4.5;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ah * Math.cos(ang - 0.5), y1 - ah * Math.sin(ang - 0.5));
      ctx.lineTo(x1 - ah * Math.cos(ang + 0.5), y1 - ah * Math.sin(ang + 0.5));
      ctx.closePath(); ctx.fill();
    }
    return cv.toDataURL();
  }

  /* ----------------------------------------------------------------------- *
   * ตัวควบคุมเวลา
   * ----------------------------------------------------------------------- */
  function setPlayIcon() {
    if (pico) pico.className = playing ? "ti ti-player-pause" : "ti ti-player-play";
    if (ptxt) ptxt.textContent = playing ? "หยุด" : (t > 0 ? "เล่นต่อ" : "เล่นจำลองน้ำท่วม");
  }
  function updateDrainBtn() {
    const btn = document.getElementById('drainBtn');
    if (!btn) return;
    if (draining) {
      btn.classList.add('active');
      if (badge) badge.textContent = 'สถานการณ์: น้ำกำลังลด — สังเกตทิศทางระบาย';
    } else {
      btn.classList.remove('active');
      badgeText();
    }
  }

  function startAnim() {
    if (animTimer) return;
    animTimer = setInterval(() => {
      if (!playing && !draining) return;
      if (draining) {
        // Real recession: t decreases → flood area contracts from periphery toward river
        // (Priority-Flood arrival order means highest-arrival cells drain first = cells
        // farthest from the river / highest elevation — physically correct)
        t = Math.max(0, t - 0.011);
        if (sld) sld.value = Math.round(t * 100);
        render(); // shrinks floodedCellList each tick; wave animation shows corridors + flow
        if (t <= 0) {
          t = 0; draining = false;
          render(); updateDrainBtn();
        }
      } else {
        t += 0.02;
        if (t >= 1) { t = 1; playing = false; setPlayIcon(); }
        if (sld) sld.value = Math.round(t * 100);
        render();
      }
    }, 80);
  }
  if (play) play.onclick = function () {
    draining = false; drainProgress = 0; updateDrainBtn();
    if (t >= 1) t = 0;
    playing = !playing; setPlayIcon(); startAnim();
  };
  if (sld) sld.oninput = function () {
    playing = false; draining = false; drainProgress = 0;
    updateDrainBtn(); setPlayIcon();
    t = sld.value / 100; render();
  };

  /* ----------------------------------------------------------------------- *
   * Real-time API — เขื่อนบางลาง (Banglong Dam ID=37) via ThaiWater API v3
   * Source: api-v3.thaiwater.net (discovered from app.chunk.js)
   * Vite proxies /api-thaiwater-v3/* → https://api-v3.thaiwater.net/*
   * ----------------------------------------------------------------------- */

  // Flood alert thresholds for Yala city (from AAR 2568)
  const FLOOD_THRESHOLDS = {
    RELEASE_MCM:  200,  // m³/s released → downstream flood risk (เขื่อนบางลางปกติ <50 m³/s)
    STORAGE_PCT:  90,   // % full → overflow risk
    INFLOW_MCM:   500,  // m³/s inflow → upstream pressure
    RAIN_MMH:     30,   // mm/hr rainfall in Yala → urban flash flood risk
  };

  const fetchMockBtn = document.getElementById("fetchMockBtn");
  const fetchStatus  = document.getElementById("fetchStatus");
  const fetchData    = document.getElementById("fetchDataDisplay");
  const damRateEl    = document.getElementById("damRate");
  const riverLevelEl = document.getElementById("riverLevel");

  let pollTimer = null;

  function badgeText() { if (badge) badge.textContent = "สถานการณ์: " + SCENARIOS[scenario].name; }

  let latestRainfall = null;
  let lastFetchTime  = null; // Fix 5: timestamp ล่าสุดที่ดึงข้อมูลสำเร็จ
  const rainfallEl   = document.getElementById("rainfallRate");
  const timestampEl  = document.getElementById("apiTimestamp");

  // Fix 5: อัปเดต "อัปเดตเมื่อ X นาทีที่แล้ว" ทุก 30 วิ
  setInterval(() => {
    if (!lastFetchTime || !timestampEl) return;
    const min = Math.round((Date.now() - lastFetchTime) / 60000);
    timestampEl.textContent = min < 1 ? "เพิ่งอัปเดต" : "อัปเดตเมื่อ " + min + " นาทีที่แล้ว";
  }, 30000);

  function applyDamData(storage, released, inflow) {
    if (damRateEl)    damRateEl.textContent    = released !== null ? released.toFixed(1) : '--';
    if (riverLevelEl) riverLevelEl.textContent = storage  !== null ? storage.toFixed(1)  : '--';
    // Fix 4: rainfall + runoff estimate
    if (rainfallEl && latestRainfall !== null) {
      // Rational formula: Q = C×I×A/3.6 — พื้นที่เมืองยะลา ~21 km², C=0.75
      const runoffCms = (0.75 * latestRainfall * 21) / 3.6;
      rainfallEl.textContent = latestRainfall.toFixed(1) + ' (น้ำท่า ~' + runoffCms.toFixed(0) + ' m³/s)';
    } else if (rainfallEl) { rainfallEl.textContent = '--'; }
    if (fetchData)    fetchData.style.display  = 'grid';

    const isFlood = (released !== null && released >= FLOOD_THRESHOLDS.RELEASE_MCM) ||
                    (storage  !== null && storage  >= FLOOD_THRESHOLDS.STORAGE_PCT)  ||
                    (inflow   !== null && inflow   >= FLOOD_THRESHOLDS.INFLOW_MCM)   ||
                    (latestRainfall !== null && latestRainfall >= FLOOD_THRESHOLDS.RAIN_MMH);

    const prevScenario = scenario;
    if (isFlood) {
      if (fetchStatus) fetchStatus.innerHTML =
        'สถานะ: <span class="text-danger">⚠ เตือนภัย! เขื่อนระบาย/เต็มระดับวิกฤต</span>';
      scenario = "high";
      if (!arrival) { badgeText(); setStatus("สถานการณ์วิกฤต — รอ DEM โหลด..."); return; }
      if (prevScenario !== "high") rebuildForScenario(); // rebuild พร้อม drainage seeds
      else { computeLevels(); if (orderOverlay) orderOverlay.setUrl(renderOrder()); }
      badgeText();
      setStatus("สถานการณ์วิกฤต: เขื่อนบางลางเร่งระบาย — รวมน้ำย้อนจากท่อระบาย");
      t = 0; playing = true; setPlayIcon(); startAnim(); render();
    } else {
      const storageTxt = storage !== null ? storage.toFixed(1) + '%' : '--';
      if (fetchStatus) fetchStatus.innerHTML =
        'สถานะ: <span style="color:var(--ok)">ปกติ — เขื่อนบางลาง ' + storageTxt + ' ไม่มีการระบายฉุกเฉิน</span>';
      scenario = "base";
      if (arrival) {
        if (prevScenario !== "base") rebuildForScenario(); // rebuild แม่น้ำหลักเท่านั้น
        else { computeLevels(); if (orderOverlay) orderOverlay.setUrl(renderOrder()); }
        badgeText(); render();
      }
      setStatus("ระดับน้ำปกติ — ไม่พบสัญญาณน้ำท่วม ณ เวลานี้");
    }
  }

  async function fetchWaterData() {
    if (!fetchMockBtn) return;
    fetchMockBtn.disabled = true;
    fetchMockBtn.innerHTML = '<i class="ti ti-loader" style="font-size:16px;"></i>กำลังเชื่อมต่อ...';
    if (fetchStatus) fetchStatus.textContent = 'สถานะ: กำลังดึงข้อมูลจาก ThaiWater API...';

    const now = new Date();

    // เขื่อนบางลาง: dam_id=50 (ไม่ใช่ 37 — dam_id=37 คือห้วยคล้า สระแก้ว)
    // ใช้ /analyst/dam?dam_id=50 ดึงข้อมูล hourly ครั้งเดียว ได้ released+inflow+storage ครบ
    const BANGLONG_URL = 'https://api-v3.thaiwater.net/api/v1/thaiwater30/analyst/dam?dam_id=50';
    const BANGLONG_CAP = 1420; // MCM total capacity เขื่อนบางลาง

    const parseBanglong = (j) => {
      if (!j || j.result !== 'OK' || !j.data) return null;
      const hourly = Array.isArray(j.data.dam_hourly) ? j.data.dam_hourly : [];
      // กรองเฉพาะ Banglong (dam_id อาจปะปนกับเขื่อนอื่น)
      const entries = hourly.filter(e => e.dam_id === 50 || (e.name && e.name.toLowerCase().includes('banglang')));
      const entry = entries.length > 0 ? entries[entries.length - 1] : (hourly.length > 0 ? hourly[0] : null);
      if (!entry) return null;
      const storageMcm = parseFloat(entry.dam_storage);
      const storagePct = parseFloat(entry.dam_storage_percent) || (storageMcm / BANGLONG_CAP * 100);
      return {
        storage: isNaN(storagePct) ? null : storagePct,
        released: parseFloat(entry.dam_released) || null,
        inflow:   parseFloat(entry.dam_inflow)   || null,
      };
    };

    const fetchBanglong = async () => {
      // 1. Direct
      try {
        const r = await fetch(BANGLONG_URL, { signal: AbortSignal.timeout(8000) });
        if (r.ok) { const d = parseBanglong(await r.json()); if (d) { console.log('[Banglong] direct', d); return d; } }
      } catch (e) { console.warn('[Banglong] direct failed', e.message); }
      // 2. Vite proxy
      try {
        const r = await fetch('/api-thaiwater-v3/api/v1/thaiwater30/analyst/dam?dam_id=50',
          { signal: AbortSignal.timeout(8000) });
        if (r.ok) { const d = parseBanglong(await r.json()); if (d) { console.log('[Banglong] vite', d); return d; } }
      } catch (e) { console.warn('[Banglong] vite failed', e.message); }
      // 3. allorigins.win
      try {
        const r = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(BANGLONG_URL),
          { signal: AbortSignal.timeout(12000) });
        if (r.ok) { const d = parseBanglong(await r.json()); if (d) { console.log('[Banglong] allorigins', d); return d; } }
      } catch (e) { console.warn('[Banglong] allorigins failed', e.message); }
      console.error('[Banglong] all tiers failed');
      return null;
    };

    // Open-Meteo — ฟรี, รองรับ CORS, ไม่ต้อง API key
    const fetchRainfall = async () => {
      try {
        const r = await fetch(
          'https://api.open-meteo.com/v1/forecast?latitude=6.55&longitude=101.28' +
          '&current=precipitation,rain&timezone=Asia%2FBangkok&forecast_days=1',
          { signal: AbortSignal.timeout(6000) }
        );
        if (!r.ok) return null;
        const j = await r.json();
        return j?.current?.precipitation ?? j?.current?.rain ?? null;
      } catch (_) { return null; }
    };

    const [dam, rainfall] = await Promise.all([fetchBanglong(), fetchRainfall()]);
    const storage  = dam ? dam.storage  : null;
    const released = dam ? dam.released : null;
    const inflow   = dam ? dam.inflow   : null;
    latestRainfall = rainfall;
    console.log('[API] storage=%o released=%o inflow=%o rainfall=%o', storage, released, inflow, rainfall);

    // Update rainfall display immediately (not waiting for render)
    if (rainfallEl) {
      if (rainfall !== null) {
        const runoffCms = (0.75 * rainfall * 21) / 3.6;
        rainfallEl.textContent = rainfall.toFixed(1) + ' (น้ำท่า ~' + runoffCms.toFixed(0) + ' m³/s)';
      } else {
        rainfallEl.textContent = '--';
      }
    }

    const anyOk = storage !== null || released !== null || inflow !== null;

    if (anyOk) {
      lastFetchTime = Date.now(); // Fix 5: บันทึกเวลา
      const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      fetchMockBtn.innerHTML = '<i class="ti ti-refresh" style="font-size:16px;"></i>อัปเดต (' + timeStr + ')';
      if (timestampEl) timestampEl.textContent = "เพิ่งอัปเดต";
      fetchMockBtn.disabled = false;
      applyDamData(storage, released, inflow);
      if (!pollTimer) pollTimer = setInterval(fetchWaterData, 5 * 60 * 1000);
    } else {
      fetchMockBtn.disabled = false;
      fetchMockBtn.innerHTML = '<i class="ti ti-cloud-download" style="font-size:16px;"></i>ลองใหม่';
      if (fetchStatus) fetchStatus.innerHTML =
        'สถานะ: <span style="color:#94a3b8">ออฟไลน์ — ไม่สามารถเชื่อมต่อ ThaiWater API ได้</span>';
    }
  }

  if (fetchMockBtn) fetchMockBtn.onclick = fetchWaterData;

  /* ----------------------------------------------------------------------- *
   * Simulation slider wiring
   * ----------------------------------------------------------------------- */
  (function initSimControls() {
    const simRainSlider = document.getElementById('simRainfall');
    const simRainVal    = document.getElementById('simRainfallVal');
    const simRiverSlider= document.getElementById('simRiver');
    const simRiverVal   = document.getElementById('simRiverVal');
    const simDamSlider  = document.getElementById('simDamLevel');
    const simDamVal     = document.getElementById('simDamLevelVal');
    const simApplyBtn   = document.getElementById('simApplyBtn');

    function updateSliderFill(slider) {
      if (!slider) return;
      const pct = ((+slider.value - +slider.min) / (+slider.max - +slider.min) * 100).toFixed(1);
      slider.style.background =
        'linear-gradient(to right, #0284c7 ' + pct + '%, #e2e8f0 ' + pct + '%)';
    }

    if (simRainSlider) {
      simRainSlider.oninput = function () {
        simInputs.rainfall = +this.value;
        if (simRainVal) simRainVal.textContent = this.value;
        updateSliderFill(this);
        updateVerdict2D();
        schedulePreview();
        saveSimState();
      };
      updateSliderFill(simRainSlider);
    }
    if (simRiverSlider) {
      simRiverSlider.oninput = function () {
        simInputs.river = +this.value;
        if (simRiverVal) simRiverVal.textContent = this.value;
        updateSliderFill(this);
        updateRiverBox(+this.value);
        updateVerdict2D();
        schedulePreview();
        saveSimState();
      };
      updateSliderFill(simRiverSlider);
      updateRiverBox(+simRiverSlider.value);   // sync กล่องแม่น้ำตอนเริ่ม
    }
    if (simDamSlider) {
      simDamSlider.oninput = function () {
        simInputs.damLevel = +this.value;
        if (simDamVal) simDamVal.textContent = this.value;
        updateSliderFill(this);
        updateVerdict2D();
        schedulePreview();
        saveSimState();
      };
      updateSliderFill(simDamSlider);
    }
    updateVerdict2D();   // ตั้งค่าการ์ดคำตัดสันตอนเริ่ม

    // ===== แชร์ค่ากับหน้า 3D ผ่าน localStorage (สลับ 2D↔3D แล้วค่าเดิมตามไป) =====
    function saveSimState() {
      try {
        localStorage.setItem('yalaSim', JSON.stringify({
          rain:  +(simRainSlider  ? simRainSlider.value  : simInputs.rainfall),
          river: +(simRiverSlider ? simRiverSlider.value : simInputs.river),
          dam:   +(simDamSlider   ? simDamSlider.value   : simInputs.damLevel)
        }));
      } catch (e) {}
    }
    // restore: ถ้ามีค่าจากอีกหน้า → ตั้งสไลเดอร์ให้ตรงกัน แต่ "ไม่เริ่มจำลองอัตโนมัติ"
    // ผู้ใช้กดปุ่ม "เล่นจำลองน้ำท่วม" / "จำลองใหม่" เอง (เหมือนหน้า 3D)
    (function restoreSimState() {
      let s = null;
      try { s = JSON.parse(localStorage.getItem('yalaSim') || 'null'); } catch (e) {}
      if (!s) return;
      if (simRainSlider  && s.rain  != null) { simRainSlider.value  = s.rain;  simInputs.rainfall = +s.rain;  if (simRainVal)  simRainVal.textContent  = s.rain;  updateSliderFill(simRainSlider); }
      if (simRiverSlider && s.river != null) { simRiverSlider.value = s.river; simInputs.river    = +s.river; if (simRiverVal) simRiverVal.textContent = s.river; updateSliderFill(simRiverSlider); updateRiverBox(+s.river); }
      if (simDamSlider   && s.dam   != null) { simDamSlider.value   = s.dam;   simInputs.damLevel = +s.dam;   if (simDamVal)   simDamVal.textContent   = s.dam;   updateSliderFill(simDamSlider); }
    })();
    if (simApplyBtn) {
      simApplyBtn.onclick = function () {
        const btn = this;
        btn.disabled = true;
        btn.innerHTML = '<i class="ti ti-loader" style="font-size:15px;"></i> กำลังจำลอง...';
        setTimeout(function () {
          applySimInputs();
          btn.disabled = false;
          btn.innerHTML = '<i class="ti ti-player-play" style="font-size:15px;"></i> จำลองใหม่';
        }, 40);
      };
    }

    // Rain zone toggle & clear
    const rainDrawToggle = document.getElementById('simRainDrawToggle');
    const rainClearAll   = document.getElementById('simRainClearAll');
    if (rainDrawToggle) rainDrawToggle.onclick = toggleRainDraw;
    if (rainClearAll) rainClearAll.onclick = function () {
      rainZones.forEach(function (z) { if (z.circle && typeof map !== 'undefined') map.removeLayer(z.circle); });
      rainZones.length = 0;
      updateRainZoneList();
    };

    // Multiplier selector buttons
    document.querySelectorAll('#simRainMultiGroup .btn-rain-opt').forEach(function (btn) {
      btn.onclick = function () {
        document.querySelectorAll('#simRainMultiGroup .btn-rain-opt').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        rainZoneMultiplier = +this.dataset.mult;
      };
    });

    // Radius selector buttons
    document.querySelectorAll('#simRainRadiusGroup .btn-rain-opt').forEach(function (btn) {
      btn.onclick = function () {
        document.querySelectorAll('#simRainRadiusGroup .btn-rain-opt').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        rainZoneRadiusM = +this.dataset.radius;
      };
    });

    // Map click → place rain zone when draw mode is active
    if (typeof map !== 'undefined') {
      map.on('click', function (e) {
        if (!rainDrawMode) return;
        addRainZone(e.latlng.lat, e.latlng.lng);
      });
    }

    // Drain button
    const drainBtnEl = document.getElementById('drainBtn');
    if (drainBtnEl) drainBtnEl.onclick = function () {
      if (draining) {
        draining = false; drainProgress = 0; updateDrainBtn();
      } else {
        if (t <= 0.01) { t = 1.0; render(); } // start from peak if at beginning
        playing = false; setPlayIcon();
        draining = true; drainProgress = 0;
        particles = null; // respawn on corridors (spawnParticle biases toward them during drain)
        updateDrainBtn(); startAnim();
      }
    };

    // Skip to end button
    const skipEndBtn = document.getElementById('skipEnd');
    if (skipEndBtn) skipEndBtn.onclick = function () {
      playing = false; setPlayIcon();
      t = 1; if (sld) sld.value = 100; render();
    };

    // Duration selector buttons
    document.querySelectorAll('#simDurationGroup .btn-sim-duration').forEach(function (btn) {
      btn.onclick = function () {
        document.querySelectorAll('#simDurationGroup .btn-sim-duration').forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');
        simLongRunHours = +this.dataset.hours;
        updateTimelineTicks();
        updateVerdict2D();
        schedulePreview();
      };
    });
  })();

  function updateTimelineTicks() {
    const tickEl = document.getElementById('trackTicks');
    if (!tickEl) return;
    const h = simLongRunHours;
    const q = Math.round(h / 4);
    // Always show 5 evenly-spaced marks to match slider width
    tickEl.innerHTML =
      '<span>0 ชม.</span><span>' + q + '</span><span>' + (q * 2) + '</span><span>' + (q * 3) + '</span><span>' + h + ' ชม.</span>';
  }
})();
