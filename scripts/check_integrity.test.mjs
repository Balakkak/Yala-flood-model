/* ============================================================================
 * check_integrity.test.mjs — ทดสอบความครบถ้วนของ data/asset (ไม่พึ่ง dependency)
 * ----------------------------------------------------------------------------
 * รัน: node --test scripts/check_integrity.test.mjs   (หรือ `npm test`)
 *
 * จับ regression คลาสเดียวกับบั๊ก "ไฟล์ validation หาย" ที่เคยเกิด:
 *   - ทุก path data/ · assets/ · lisflood/ ที่ HTML/JS อ้างถึง ต้องมีไฟล์จริง
 *   - GeoJSON/JSON สำคัญต้อง parse ได้ + มี schema ที่โค้ดคาดหวัง
 * ========================================================================== */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const readJSON = (p) => JSON.parse(read(p));
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const PAGES = ["index.html", "dashboard.html", "city3d.html", "interventions.html"];
const SCRIPTS = ["assets/flood_analysis.js", "assets/live_status.js", "assets/lisflood_viewer.js"];

// รวบรวม path ภายในที่ถูกอ้างถึง (ข้าม http, template {z}/{x}, และ data-URI)
function referencedPaths() {
  const files = [...PAGES, ...SCRIPTS];
  const re = /(?:href|src|fetch\(\s*['"`]|url\(\s*['"`]?)?\b((?:assets|data|terrain|lisflood)\/[A-Za-z0-9_฀-๿./-]+\.[A-Za-z0-9]+)/g;
  const found = new Set();
  for (const f of files) {
    const txt = read(f);
    let m;
    while ((m = re.exec(txt))) {
      const p = m[1];
      if (p.includes("{") || p.includes("$")) continue; // template เช่น terrain/{z}/{x}/{y}.png
      found.add(p);
    }
  }
  return [...found].sort();
}

test("referenced data/asset files ทั้งหมดมีอยู่จริง", () => {
  const missing = referencedPaths().filter((p) => !exists(p));
  assert.deepEqual(missing, [], `ไฟล์ที่อ้างถึงแต่หาไม่เจอ:\n  ${missing.join("\n  ")}`);
});

test("entry pages + core scripts มีครบ", () => {
  for (const f of [...PAGES, ...SCRIPTS, "assets/styles.css"]) {
    assert.ok(exists(f), `ขาดไฟล์: ${f}`);
  }
});

test("yala_flood_recurrence.geojson มี schema ที่ dashboard ใช้", () => {
  const d = readJSON("data/yala_flood_recurrence.geojson");
  assert.equal(d.type, "FeatureCollection");
  assert.ok(d.features.length >= 10, "ควรมีอย่างน้อย ~14 ตำบล");
  for (const f of d.features) {
    assert.ok("flood_area_pct" in f.properties, "ขาด flood_area_pct");
    assert.ok("subdistrict" in f.properties, "ขาด subdistrict");
    assert.ok(f.geometry, "ขาด geometry");
  }
});

test("dem_grid.json มีฟิลด์ที่หน้า 3D + validator ใช้", () => {
  const g = readJSON("data/dem_grid.json");
  for (const key of ["ncols", "nrows", "origin_lon", "origin_lat", "dlon", "dlat", "ground_m", "channel"]) {
    assert.ok(key in g, `ขาดฟิลด์ ${key}`);
  }
  assert.equal(g.ground_m.length, g.ncols * g.nrows, "ground_m ขนาดไม่ตรง ncols×nrows");
});

test("GeoJSON หลักทุกไฟล์ parse ได้และเป็น FeatureCollection", () => {
  const core = [
    "data/yala_boundary.geojson",
    "data/yala_buildings.geojson",
    "data/yala_tambons.geojson",
    "data/yala_flood_gistda_kmz.geojson",
    "data/yala_major_river_validated.geojson",
  ];
  for (const p of core) {
    const d = readJSON(p);
    assert.equal(d.type, "FeatureCollection", `${p} ไม่ใช่ FeatureCollection`);
    assert.ok(Array.isArray(d.features) && d.features.length > 0, `${p} ไม่มี features`);
  }
});

test("flood_response.json มี base/onset stage สำหรับเกณฑ์น้ำท่วม", () => {
  const fr = readJSON("data/flood_response.json");
  assert.equal(typeof fr.base_stage_m, "number");
  assert.equal(typeof fr.onset_stage_m, "number");
});
