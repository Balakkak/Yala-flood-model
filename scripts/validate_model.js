/* ============================================================================
 * validate_model.js — ตรวจความแม่นยำตัววิเคราะห์น้ำท่วม (Priority-Flood)
 * เทียบกับ ground truth อิสระจากดาวเทียม/บันทึกจริง (GISTDA)
 * ----------------------------------------------------------------------------
 * ★ ไม่พึ่ง dependency ใด ๆ — ใช้ data/dem_grid.json (DEM 30 ม. แปลงเป็น JSON แล้ว)
 *   จึงรันได้ด้วย `node scripts/validate_model.js` หรือ `npm test` ทันที
 *
 * แนวคิด: โมเดลให้ "arrival level" ของแต่ละเซลล์ (ต่ำ = ท่วมก่อน/ง่าย)
 *   ถ้าโมเดลแม่น เซลล์ที่ arrival ต่ำควรตรงกับพื้นที่ที่ GISTDA บอกว่าเคยท่วม
 * วัดด้วย rank-based metrics (ทนต่อ datum error ของ DEM):
 *   - ROC-AUC   : โมเดลแยก "เคยท่วม" ออกจาก "ไม่เคยท่วม" ได้ดีแค่ไหน (0.5=มั่ว, 1=สมบูรณ์)
 *   - Spearman ρ: สหสัมพันธ์อันดับ arrival vs จำนวนแหล่งข้อมูลที่ยืนยันว่าท่วม (คาดติดลบ)
 *   - POD/FAR/CSI: ที่ขอบเขตน้ำท่วมของโมเดล จับพื้นที่ท่วมจริงได้กี่ %
 *   - baseline  : เทียบกับ "ใช้ระดับความสูงล้วน" เพื่อดูว่า connectivity เพิ่มค่าจริงไหม
 *
 * Ground truth = ซ้อน 3 ชุดข้อมูลน้ำท่วม GISTDA ที่เป็นอิสระต่อกัน → recur 0–3
 *   (1) yala_flood_gistda_kmz        พื้นที่น้ำท่วมจากดาวเทียม (โพลิกอน)
 *   (2) yala_riverbank_flood         จุดน้ำท่วมริมตลิ่ง (จุด)
 *   (3) yala_overflow_flood_official แนวน้ำล้น/ท่วมราชการ (เส้น)
 *   recur[cell] = จำนวนชุดข้อมูลที่ยืนยันว่าเซลล์นั้นท่วม (ยิ่งมาก = มั่นใจว่าเคยท่วมจริง)
 * ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");
const D = (p) => path.join(__dirname, "..", "data", p);
const J = (p) => JSON.parse(fs.readFileSync(D(p), "utf8"));

// ---------- 1) DEM grid (จาก dem_grid.json — ตรงกับที่หน้า 3D ใช้) ----------
const G = J("dem_grid.json");
const NC = G.ncols, NR = G.nrows, N = NC * NR;
const ground = Float32Array.from(G.ground_m);
const valid = new Uint8Array(N);
for (let i = 0; i < N; i++) valid[i] = (ground[i] > 0 && ground[i] < 9000 && isFinite(ground[i])) ? 1 : 0;
const lonOf = (c) => G.origin_lon + (c + 0.5) * G.dlon;
const latOf = (r) => G.origin_lat - (r + 0.5) * G.dlat;       // origin_lat = ขอบเหนือ
const colOf = (lon) => Math.floor((lon - G.origin_lon) / G.dlon);
const rowOf = (lat) => Math.floor((G.origin_lat - lat) / G.dlat);

// ---------- 2) Priority-Flood seeded จาก channel (ทางน้ำจริง) ----------
const arrival = new Float32Array(N).fill(Infinity);
const k = [], v = [];
const sw = (a, b) => { const x = k[a]; k[a] = k[b]; k[b] = x; const y = v[a]; v[a] = v[b]; v[b] = y; };
const pu = (K, V) => { let i = k.length; k.push(K); v.push(V); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; sw(p, i); i = p; } };
const po = () => { const tk = k[0], tv = v[0], n = k.length - 1; k[0] = k[n]; v[0] = v[n]; k.pop(); v.pop(); let i = 0; while (1) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < k.length && k[l] < k[s]) s = l; if (r < k.length && k[r] < k[s]) s = r; if (s === i) break; sw(s, i); i = s; } return [tk, tv]; };
let seeds = 0;
if (Array.isArray(G.channel)) for (const i of G.channel) if (valid[i]) { arrival[i] = ground[i]; pu(ground[i], i); seeds++; }
const NB = [-1, 1, -NC, NC, -NC - 1, -NC + 1, NC - 1, NC + 1];
while (k.length) {
  const [L, c] = po(); if (L > arrival[c]) continue; const cx = c % NC;
  for (let d = 0; d < 8; d++) { const nb = c + NB[d]; if (nb < 0 || nb >= N || !valid[nb]) continue; if (Math.abs(nb % NC - cx) > 1) continue; const nl = Math.max(L, ground[nb]); if (nl < arrival[nb]) { arrival[nb] = nl; pu(nl, nb); } }
}

// ---------- 3) study mask = เขตเมือง (yala_boundary) ----------
const SB = J("yala_boundary.geojson").features[0].geometry.coordinates[0];
const pin = (lo, la, ring) => { let s = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if (((yi > la) !== (yj > la)) && (lo < (xj - xi) * (la - yi) / (yj - yi) + xi)) s = !s; } return s; };
const inStudy = new Uint8Array(N); let sc = 0;
for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) { const i = r * NC + c; if (valid[i] && pin(lonOf(c), latOf(r), SB)) { inStudy[i] = 1; sc++; } }

// ---------- 4) ground truth: ซ้อน 3 ชุดข้อมูล GISTDA → recur 0–3 ----------
const hitPoly = new Uint8Array(N), hitPt = new Uint8Array(N), hitLine = new Uint8Array(N);
const eachPoly = (geom, cb) => {
  if (!geom) return;
  const t = geom.type;
  if (t === "Polygon") cb(geom.coordinates);
  else if (t === "MultiPolygon") geom.coordinates.forEach(cb);
  else if (t === "GeometryCollection") geom.geometries.forEach((g) => eachPoly(g, cb));
};
const fillRing = (ring, out) => {
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9;
  for (const p of ring) { if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0]; if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1]; }
  const c0 = Math.max(0, colOf(mnx)), c1 = Math.min(NC - 1, colOf(mxx));
  const r0 = Math.max(0, rowOf(mxy)), r1 = Math.min(NR - 1, rowOf(mny));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * NC + c; if (out[i]) continue; if (pin(lonOf(c), latOf(r), ring)) out[i] = 1; }
};
// (1) polygons
for (const f of J("yala_flood_gistda_kmz.geojson").features) eachPoly(f.geometry, (poly) => fillRing(poly[0], hitPoly));
// (2) points
const markPt = (lo, la) => { const c = colOf(lo), r = rowOf(la); if (c >= 0 && c < NC && r >= 0 && r < NR) hitPt[r * NC + c] = 1; };
for (const f of J("yala_riverbank_flood.geojson").features) { const g = f.geometry; if (g && g.type === "Point") markPt(g.coordinates[0], g.coordinates[1]); }
// (3) lines (เดินตามเซลล์)
const eachLine = (geom, cb) => { if (!geom) return; const t = geom.type; if (t === "LineString") cb(geom.coordinates); else if (t === "MultiLineString") geom.coordinates.forEach(cb); else if (t === "GeometryCollection") geom.geometries.forEach((g) => eachLine(g, cb)); };
const markLine = (co) => { for (let s = 0; s < co.length - 1; s++) { const a = co[s], b = co[s + 1]; const x1 = (a[0] - G.origin_lon) / G.dlon, y1 = (G.origin_lat - a[1]) / G.dlat, x2 = (b[0] - G.origin_lon) / G.dlon, y2 = (G.origin_lat - b[1]) / G.dlat; const st = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1))); for (let t = 0; t <= st; t++) { const f = t / st, cc = Math.floor(x1 + (x2 - x1) * f), rr = Math.floor(y1 + (y2 - y1) * f); if (cc >= 0 && cc < NC && rr >= 0 && rr < NR) hitLine[rr * NC + cc] = 1; } } };
for (const f of J("yala_overflow_flood_official.geojson").features) eachLine(f.geometry, markLine);

const recur = new Int8Array(N);
for (let i = 0; i < N; i++) recur[i] = hitPoly[i] + hitPt[i] + hitLine[i];

// ---------- 5) เก็บคู่ (arrival, recur) เฉพาะเซลล์เมืองที่ reachable ----------
const A = [], R = [], E = [];
for (let i = 0; i < N; i++) if (inStudy[i] && isFinite(arrival[i])) { A.push(arrival[i]); R.push(recur[i]); E.push(ground[i]); }
const M = A.length;
const covered = R.filter((x) => x > 0).length;
console.log(`DEM grid ${NC}×${NR} · channel seeds ${seeds} · เซลล์เมืองที่ตรวจสอบ ${M} (GISTDA ทับ ${covered} = ${(M ? covered / M * 100 : 0).toFixed(1)}%)`);

// ---------- metrics ----------
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

console.log("\n=== ROC-AUC : โมเดลแยก 'พื้นที่เคยท่วม' จาก 'ไม่เคยท่วม' (เทียบ baseline ระดับสูงล้วน) ===");
for (const thr of [1, 2, 3]) {
  const lab = R.map((x) => x >= thr ? 1 : 0); const np = lab.filter(Boolean).length;
  if (!np) { console.log(`  ยืนยัน ≥${thr} แหล่ง: (ไม่มีเซลล์)`); continue; }
  const aM = auc(negArr, lab), aE = auc(negElev, lab);
  console.log(`  ยืนยัน ≥${thr} แหล่ง (${np} เซลล์): โมเดล AUC ${aM.toFixed(3)} | baseline ${aE.toFixed(3)} | ดีกว่า ${(aM - aE >= 0 ? "+" : "")}${(aM - aE).toFixed(3)}`);
}
console.log("\n=== Spearman ρ : อันดับ arrival vs จำนวนแหล่งยืนยัน (คาดติดลบ = ท่วมง่าย↔ยืนยันมาก) ===");
console.log(`  ρ(arrival, recurrence) = ${spearman(A, R).toFixed(3)}`);

const sortedCity = [...A].sort((a, b) => a - b);
console.log("\n=== POD / FAR / CSI : ที่ขอบเขตน้ำท่วมของโมเดล จับพื้นที่ท่วมจริงได้แค่ไหน ===");
for (const [scn, pct] of [["base 35%", 0.35], ["high 65%", 0.65]]) {
  const sMax = sortedCity[Math.floor(pct * (sortedCity.length - 1))];
  for (const thr of [1, 2]) {
    let hit = 0, miss = 0, fa = 0;
    for (let i = 0; i < M; i++) { const pred = A[i] <= sMax, obs = R[i] >= thr; if (pred && obs) hit++; else if (!pred && obs) miss++; else if (pred && !obs) fa++; }
    const pod = hit / (hit + miss || 1), far = fa / (hit + fa || 1), csi = hit / (hit + miss + fa || 1);
    console.log(`  ${scn} vs ท่วมจริง ≥${thr} แหล่ง: POD ${(pod * 100).toFixed(0)}% · FAR ${(far * 100).toFixed(0)}% · CSI ${csi.toFixed(2)}`);
  }
}

// ---------- เขียนสรุป ----------
const auc1 = auc(negArr, R.map((x) => x >= 1 ? 1 : 0));
const auc2 = auc(negArr, R.map((x) => x >= 2 ? 1 : 0));
const rho = spearman(A, R);
const out = {
  ground_truth: "GISTDA flood layers (satellite polygons + riverbank points + official overflow lines), 0–3 agreement",
  method: "Priority-Flood (minimax connectivity) on dem_grid.json (FABDEM 30m), seeded from real channel cells",
  city_cells: M,
  gistda_coverage_pct: +(M ? covered / M * 100 : 0).toFixed(1),
  auc_any: +auc1.toFixed(3),
  auc_agree2: +auc2.toFixed(3),
  spearman: +rho.toFixed(3),
  generated: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(D("validation_result.json"), JSON.stringify(out, null, 2));
console.log("\n✅ wrote data/validation_result.json");

// ---------- sanity gate (ให้ npm test ฟ้องถ้าโมเดลแย่กว่าการเดาสุ่ม) ----------
const aBase = auc(negElev, R.map((x) => x >= 1 ? 1 : 0));
if (!isFinite(auc1) || auc1 < 0.5) { console.error(`\n❌ FAIL: AUC ${auc1} ไม่ดีกว่าการเดาสุ่ม (0.5)`); process.exit(1); }
console.log(`\n✓ PASS: โมเดล AUC ${auc1.toFixed(3)} (baseline ${isFinite(aBase) ? aBase.toFixed(3) : "n/a"}) — ดีกว่าการเดาสุ่ม`);
