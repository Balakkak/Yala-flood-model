/* ============================================================================
 * validate_model.js — ตรวจสอบความแม่นยำของตัววิเคราะห์น้ำท่วม (Priority-Flood)
 * เทียบกับ ground truth อิสระ: GISTDA พื้นที่น้ำท่วมซ้ำซากจริง 2554–2566
 *
 * แนวคิด: โมเดลให้ "arrival level" ของแต่ละเซลล์ (ต่ำ = ท่วมก่อน/ง่าย)
 *         ถ้าโมเดลแม่น เซลล์ที่ arrival ต่ำ ควรตรงกับพื้นที่ที่ GISTDA บอกว่าท่วม "บ่อย"
 * วัดด้วย rank-based metrics (ทนต่อ datum error ของ AW3D30):
 *   - ROC-AUC : โมเดลแยกพื้นที่ "ท่วมบ่อย" ออกจาก "ไม่ค่อยท่วม" ได้ดีแค่ไหน (0.5=มั่ว, 1=สมบูรณ์)
 *   - Spearman ρ : สหสัมพันธ์อันดับ arrival vs ความถี่ท่วมจริง (คาดว่าติดลบ)
 *   - POD/FAR/CSI : ที่ขอบเขตน้ำท่วมของโมเดล จับพื้นที่ท่วมจริงได้กี่ %
 *   - baseline : เทียบกับ "ใช้ระดับความสูงล้วน" เพื่อดูว่า connectivity เพิ่มค่าไหม
 * รัน: node scripts/validate_model.js
 * ========================================================================== */
const GeoTIFF = require("geotiff"), fs = require("fs"), path = require("path");
const D = (p) => path.join(__dirname, "..", "data", p);
const J = (p) => JSON.parse(fs.readFileSync(D(p), "utf8"));

(async () => {
  // ---------- 1) สร้างโมเดล (ตรงกับ assets/flood_analysis.js) ----------
  const buf = fs.readFileSync(D("output_AW3D30.tif"));
  const tiff = await GeoTIFF.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const im = await tiff.getImage(); const W0 = im.getWidth(), H0 = im.getHeight(), bbox = im.getBoundingBox();
  const raw = (await im.readRasters({ interleave: false }))[0];
  const F = 2, W = Math.floor(W0 / F), H = Math.floor(H0 / F);
  const elev = new Float32Array(W * H), valid = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let m = 1e9, a = 0;
    for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) { const e = raw[(r * F + dy) * W0 + (c * F + dx)]; if (e > 0 && e < 9000 && isFinite(e)) { if (e < m) m = e; a = 1; } }
    const i = r * W + c; if (a) { elev[i] = m; valid[i] = 1; } else elev[i] = 1e6;
  }
  const resX = (bbox[2] - bbox[0]) / W, resY = (bbox[3] - bbox[1]) / H;
  const lonOf = (c) => bbox[0] + (c + 0.5) * resX, latOf = (r) => bbox[3] - (r + 0.5) * resY;

  // study/region mask
  const SB = J("yala_boundary.geojson").features[0].geometry.coordinates[0];
  const pin = (lo, la, ring) => { let s = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if (((yi > la) !== (yj > la)) && (lo < (xj - xi) * (la - yi) / (yj - yi) + xi)) s = !s; } return s; };
  const BUF = 0.025, rw = Math.min(...SB.map(p => p[0])) - BUF, re = Math.max(...SB.map(p => p[0])) + BUF, rs = Math.min(...SB.map(p => p[1])) - BUF, rn = Math.max(...SB.map(p => p[1])) + BUF;
  const inStudy = new Uint8Array(W * H), inRegion = new Uint8Array(W * H); let sc = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const i = r * W + c; if (!valid[i]) continue; const lo = lonOf(c), la = latOf(r); if (lo >= rw && lo <= re && la >= rs && la <= rn) inRegion[i] = 1; if (pin(lo, la, SB)) { inStudy[i] = 1; sc++; } }

  // sources (river synthetic + OSM + eastern) -> priority flood
  const layers = ["yala_waterways.geojson", "yala_waterways_osm.geojson", "yala_eastern_inflow.geojson"].map((p) => { try { return J(p); } catch { return null; } }).filter(Boolean);
  const gl = (g) => g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
  const source = new Uint8Array(W * H);
  const mark = (x, r) => { if (x >= 0 && x < W && r >= 0 && r < H && valid[r * W + x]) source[r * W + x] = 1; };
  layers.forEach((L) => (L.features || []).forEach((f) => gl(f.geometry).forEach((co) => { for (let i = 0; i < co.length - 1; i++) { const [a, b] = co[i], [c, d] = co[i + 1]; const x1 = (a - bbox[0]) / resX, y1 = (bbox[3] - b) / resY, x2 = (c - bbox[0]) / resX, y2 = (bbox[3] - d) / resY; const st = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2)); for (let s = 0; s <= st; s++) { const t = s / st; mark(Math.floor(x1 + (x2 - x1) * t), Math.floor(y1 + (y2 - y1) * t)); } } })));
  const arrival = new Float32Array(W * H).fill(Infinity);
  const k = [], v = []; const sw = (a, b) => { const x = k[a]; k[a] = k[b]; k[b] = x; const y = v[a]; v[a] = v[b]; v[b] = y; }; const pu = (K, V) => { let i = k.length; k.push(K); v.push(V); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; sw(p, i); i = p; } }; const po = () => { const tk = k[0], tv = v[0], n = k.length - 1; k[0] = k[n]; v[0] = v[n]; k.pop(); v.pop(); let i = 0; while (1) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < k.length && k[l] < k[s]) s = l; if (r < k.length && k[r] < k[s]) s = r; if (s === i) break; sw(s, i); i = s; } return [tk, tv]; };
  for (let i = 0; i < W * H; i++) if (source[i]) { arrival[i] = elev[i]; pu(elev[i], i); }
  const NB = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
  while (k.length) { const [L, c] = po(); if (L > arrival[c]) continue; const cx = c % W; for (let d = 0; d < 8; d++) { const nb = c + NB[d]; if (nb < 0 || nb >= W * H || !valid[nb]) continue; if (Math.abs(nb % W - cx) > 1) continue; const nl = Math.max(L, elev[nb]); if (nl < arrival[nb]) { arrival[nb] = nl; pu(nl, nb); } } }

  // ---------- 2) rasterize GISTDA recurrence -> recur[cell] ----------
  const recur = new Int8Array(W * H); // จำนวนครั้งท่วมจริง (0–8)
  const gistda = J("yala_flood_recurrence.geojson");
  const ringFill = (ring, val) => {
    let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
    for (const [lo, la] of ring) { if (lo < mnx) mnx = lo; if (lo > mxx) mxx = lo; if (la < mny) mny = la; if (la > mxy) mxy = la; }
    const c0 = Math.max(0, Math.floor((mnx - bbox[0]) / resX)), c1 = Math.min(W - 1, Math.ceil((mxx - bbox[0]) / resX));
    const r0 = Math.max(0, Math.floor((bbox[3] - mxy) / resY)), r1 = Math.min(H - 1, Math.ceil((bbox[3] - mny) / resY));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * W + c; if (!inRegion[i]) continue;
      if (pin(lonOf(c), latOf(r), ring) && val > recur[i]) recur[i] = val;
    }
  };
  for (const f of gistda.features) {
    let n = f.properties.total_floods;
    if (n == null) n = f.properties.years_flooded ? f.properties.years_flooded.split(",").filter(Boolean).length : 0;
    if (!n) continue;
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates : g.type === "Polygon" ? [g.coordinates] : [];
    for (const poly of polys) ringFill(poly[0], n); // outer ring
  }

  // ---------- 3) เก็บคู่ (arrival, recur) เฉพาะเซลล์เมืองที่ reachable ----------
  const A = [], R = [], E = [];
  for (let i = 0; i < W * H; i++) if (inStudy[i] && isFinite(arrival[i])) { A.push(arrival[i]); R.push(recur[i]); E.push(elev[i]); }
  const N = A.length;
  const covered = R.filter((x) => x > 0).length;
  console.log(`เซลล์เมืองที่ใช้ตรวจสอบ: ${N} (มี GISTDA ทับ ${covered} = ${(covered / N * 100).toFixed(1)}%)`);

  // ---------- metrics ----------
  // AUC (Mann-Whitney) : score สูง = เสี่ยงมาก. ใช้ score = -arrival (ยิ่ง arrival ต่ำ ยิ่งเสี่ยง)
  function auc(scores, labels) {
    const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
    const rank = new Float64Array(scores.length);
    for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && scores[idx[j]] === scores[idx[i]]) j++; const avg = (i + j + 1) / 2; for (let t = i; t < j; t++) rank[idx[t]] = avg; i = j; }
    let np = 0, nn = 0, sr = 0;
    for (let i = 0; i < labels.length; i++) { if (labels[i]) { np++; sr += rank[i]; } else nn++; }
    if (!np || !nn) return NaN;
    return (sr - np * (np + 1) / 2) / (np * nn);
  }
  function spearman(x, y) {
    const rk = (arr) => { const idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]); const rank = new Float64Array(arr.length); for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && arr[idx[j]] === arr[idx[i]]) j++; const avg = (i + j + 1) / 2; for (let t = i; t < j; t++) rank[idx[t]] = avg; i = j; } return rank; };
    const rx = rk(x), ry = rk(y); const n = x.length; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += rx[i]; my += ry[i]; } mx /= n; my /= n;
    let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { const dx = rx[i] - mx, dy = ry[i] - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy; }
    return sxy / Math.sqrt(sx * sy);
  }
  const negArr = A.map((a) => -a), negElev = E.map((e) => -e);

  console.log("\n=== ROC-AUC : โมเดลแยก 'พื้นที่ท่วมบ่อย' จาก 'ไม่ค่อยท่วม' ได้ดีแค่ไหน ===");
  for (const thr of [1, 2, 3]) {
    const lab = R.map((x) => x >= thr ? 1 : 0);
    const aM = auc(negArr, lab), aE = auc(negElev, lab);
    console.log(`  ท่วม ≥${thr} ครั้ง (${lab.filter(Boolean).length} เซลล์): โมเดล AUC = ${aM.toFixed(3)} | baseline(ระดับสูงล้วน) = ${aE.toFixed(3)} | ดีกว่า +${(aM - aE).toFixed(3)}`);
  }
  console.log("\n=== Spearman ρ : อันดับ arrival vs ความถี่ท่วมจริง (คาดติดลบ = ท่วมง่าย↔ท่วมบ่อย) ===");
  console.log(`  ρ(arrival, recurrence) = ${spearman(A, R).toFixed(3)}`);

  // POD/FAR/CSI ที่ขอบเขตน้ำท่วมของโมเดล (high scenario = 65th pct ของ arrival เมือง)
  const sortedCity = [...A].sort((a, b) => a - b);
  console.log("\n=== POD / FAR / CSI : ที่ขอบเขตน้ำท่วมของโมเดล จับพื้นที่ท่วมจริงได้แค่ไหน ===");
  for (const [scn, pct] of [["base 35%", 0.35], ["high 65%", 0.65]]) {
    const sMax = sortedCity[Math.floor(pct * (sortedCity.length - 1))];
    for (const thr of [1, 3]) {
      let hit = 0, miss = 0, fa = 0;
      for (let i = 0; i < N; i++) { const pred = A[i] <= sMax, obs = R[i] >= thr; if (pred && obs) hit++; else if (!pred && obs) miss++; else if (pred && !obs) fa++; }
      const pod = hit / (hit + miss), far = fa / (hit + fa), csi = hit / (hit + miss + fa);
      console.log(`  ${scn} vs ท่วมจริง ≥${thr}: POD ${(pod * 100).toFixed(0)}% (จับได้) · FAR ${(far * 100).toFixed(0)}% (เตือนเกิน) · CSI ${csi.toFixed(2)}`);
    }
  }

  // เขียนสรุปสำหรับแดชบอร์ด
  const auc3 = auc(negArr, R.map((x) => x >= 3 ? 1 : 0));
  const auc1 = auc(negArr, R.map((x) => x >= 1 ? 1 : 0));
  const rho = spearman(A, R);
  fs.writeFileSync(D("validation_result.json"), JSON.stringify({
    ground_truth: "GISTDA recurrent flood 2011–2023", city_cells: N, gistda_coverage_pct: +(covered / N * 100).toFixed(1),
    auc_freq3: +auc3.toFixed(3), auc_any: +auc1.toFixed(3), spearman: +rho.toFixed(3),
    generated: new Date().toISOString().slice(0, 10),
  }, null, 2));
  console.log("\n✅ wrote data/validation_result.json");
})().catch((e) => console.error(e));
