/* ============================================================================
 * intervention_3d.js — มุมมอง 3D ของเครื่องเปรียบเทียบ ก่อน–หลังสร้าง
 * ----------------------------------------------------------------------------
 * MapLibre + custom WebGL water (ดัดแปลงจาก index.html) :
 *   - terrain FABDEM + อาคาร 3D + ผิวน้ำเคลื่อนไหว
 *   - ส่ง arrival "ก่อน" และ "หลัง" เป็น 2 attribute → shader เลือกตาม u_split
 *     (a_pos.x < u_split = ก่อน · ฝั่งซ้าย/ตะวันตก) → swipe เดียวเท่ากับ 2D
 *   - u_stage = ระดับออกแบบคงที่ · เปิด/ปิดคันกั้น → อัปเดต buffer "หลัง"
 * ========================================================================== */
window.IV3D = (function () {
  "use strict";
  var map = null, built = false, gl = null, meta;
  var positions, uvs, grounds, arrB, arrA, flowArr, indices, M2, N, NC, NR;
  var prog, vao, posB, uvB, gndB, arrBB, arrAB, flowB, idxB;
  var aPos, aUv, aGnd, aArrB, aArrA, aFlow, uMat, uTime, uM2, uStage, uSplit, uFlowOn;
  var t0 = performance.now(), uSplitX = 1e9;
  var stageCur = 18.25, stageTarget = 18.25, flowOn = 1.0;

  function mercXOf(lng) { return maplibregl.MercatorCoordinate.fromLngLat({ lng: lng, lat: 6.547 }, 0).x; }

  function buildArrays() {
    meta = IVCompare.meta(); NC = meta.NC; NR = meta.NR; N = meta.N;
    var ar = IVCompare.arrays(), A = IVCompare.arrivals(), ground = ar.ground, ff = IVCompare.flowField();
    M2 = maplibregl.MercatorCoordinate.fromLngLat({ lng: 101.285, lat: 6.547 }, 0).meterInMercatorCoordinateUnits();
    positions = new Float32Array(N * 2); uvs = new Float32Array(N * 2);
    grounds = new Float32Array(N); arrB = new Float32Array(N); arrA = new Float32Array(N); flowArr = new Float32Array(N * 2);
    for (var r = 0; r < NR; r++) for (var c = 0; c < NC; c++) {
      var i = r * NC + c, lng = meta.OLON + (c + 0.5) * meta.DLON, lat = meta.OLAT - (r + 0.5) * meta.DLAT;
      var p = maplibregl.MercatorCoordinate.fromLngLat({ lng: lng, lat: lat }, 0);
      positions[i * 2] = p.x; positions[i * 2 + 1] = p.y; uvs[i * 2] = (c + 0.5) / NC; uvs[i * 2 + 1] = (r + 0.5) / NR;
      grounds[i] = ground[i];
      arrB[i] = isFinite(A.base[i]) ? A.base[i] : 99999;
      arrA[i] = isFinite(A.after[i]) ? A.after[i] : 99999;
      flowArr[i * 2] = ff.fx[i]; flowArr[i * 2 + 1] = ff.fy[i];      // ทิศไหลใน uv-space (u=ตอ., v=ใต้)
    }
    var idx = [];
    for (var rr = 0; rr < NR - 1; rr++) for (var cc = 0; cc < NC - 1; cc++) {
      var a = rr * NC + cc, b = a + 1, d = (rr + 1) * NC + cc, e = d + 1; idx.push(a, b, d, b, e, d);
    }
    indices = new Uint32Array(idx);
  }

  var VS = "attribute vec2 a_pos;attribute vec2 a_uv;attribute float a_ground;attribute float a_arrB;attribute float a_arrA;attribute vec2 a_flow;" +
    "uniform mat4 u_matrix;uniform float u_time;uniform float u_m2;uniform float u_stage;uniform float u_split;uniform float u_flowOn;" +
    "varying float v_depth;varying vec3 v_n;varying vec2 v_uv;varying float v_flow;void main(){" +
    "float arr=(a_pos.x < u_split)?a_arrB:a_arrA;" +              /* ซ้าย=ก่อน, ขวา=หลัง */
    "float depth=(arr<=u_stage)?max(0.0,u_stage-a_ground):0.0;" +
    "float amp=clamp(depth*2.0,0.0,1.0);vec2 g=a_uv*48.0;" +
    "vec2 d1=vec2(0.30,0.95),d2=vec2(0.82,0.28),d3=vec2(-0.55,0.70);" +
    "float p1=dot(g,d1)+u_time*0.72;float p2=dot(g,d2)*1.5+u_time*0.50;float p3=dot(g,d3)*2.2+u_time*0.92;" +
    "float w=0.038*sin(p1)+0.022*sin(p2)+0.012*sin(p3);" +
    "vec2 gr=0.038*cos(p1)*d1+0.022*cos(p2)*d2*1.5+0.012*cos(p3)*d3*2.2;" +
    "float fl=length(a_flow);vec2 fdir=fl>0.01?a_flow/fl:vec2(0.0,1.0);" +   /* ระลอกวิ่งตามทิศไหลลงปลายน้ำ → อ้อมคันกั้น */
    "float pf=dot(a_uv*62.0,fdir)-u_time*1.5;" +
    "w+=0.034*sin(pf)*fl*u_flowOn;gr+=0.034*cos(pf)*fdir*fl*u_flowOn;v_flow=fl*u_flowOn;" +
    "float surf=max(depth+w*amp,0.02);v_n=normalize(vec3(-gr*amp,1.0));v_depth=depth;v_uv=a_uv;" +
    "float z=(a_ground+surf)*u_m2;gl_Position=u_matrix*vec4(a_pos,z,1.0);}";
  var FS = "precision highp float;varying float v_depth;varying vec3 v_n;varying vec2 v_uv;varying float v_flow;uniform float u_time;void main(){" +
    "if(v_depth<0.03)discard;float dn=clamp(v_depth/2.5,0.0,1.0);" +
    "vec3 col=mix(vec3(0.32,0.64,0.82),vec3(0.02,0.18,0.42),dn);" +
    "vec3 N=normalize(v_n),V=vec3(0.0,0.0,1.0),L=normalize(vec3(0.55,0.35,0.78)),H=normalize(L+V);" +
    "float spec=pow(max(dot(N,H),0.0),55.0);float fres=pow(1.0-max(dot(N,V),0.0),4.0);" +
    "col=mix(col,vec3(0.62,0.80,0.95),fres*0.55);col+=vec3(1.0,0.97,0.85)*spec*0.7;" +
    "float foam=(1.0-smoothstep(0.03,0.35,v_depth))*0.55;col=mix(col,vec3(0.92,0.97,1.0),foam*0.6);" +
    "col=mix(col,vec3(0.80,0.92,1.0),clamp(v_flow,0.0,1.0)*0.16);" +     /* ริ้วการไหล */
    "float a=mix(0.42,0.9,dn)+spec*0.35+foam*0.25;gl_FragColor=vec4(col,clamp(a,0.0,0.96));}";

  var waterLayer = {
    id: "iv-water3d", type: "custom", renderingMode: "3d",
    onAdd: function (_m, glc) {
      gl = glc;
      var sh = function (t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.error("iv-water:", gl.getShaderInfoLog(o)); return o; };
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error("iv-water link:", gl.getProgramInfoLog(prog));
      aPos = gl.getAttribLocation(prog, "a_pos"); aUv = gl.getAttribLocation(prog, "a_uv");
      aGnd = gl.getAttribLocation(prog, "a_ground"); aArrB = gl.getAttribLocation(prog, "a_arrB"); aArrA = gl.getAttribLocation(prog, "a_arrA"); aFlow = gl.getAttribLocation(prog, "a_flow");
      uMat = gl.getUniformLocation(prog, "u_matrix"); uTime = gl.getUniformLocation(prog, "u_time");
      uM2 = gl.getUniformLocation(prog, "u_m2"); uStage = gl.getUniformLocation(prog, "u_stage"); uSplit = gl.getUniformLocation(prog, "u_split"); uFlowOn = gl.getUniformLocation(prog, "u_flowOn");
      var mk = function (data, type) { var b = gl.createBuffer(); gl.bindBuffer(type || gl.ARRAY_BUFFER, b); gl.bufferData(type || gl.ARRAY_BUFFER, data, type ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW); return b; };
      posB = mk(positions); uvB = mk(uvs); gndB = mk(grounds);
      arrBB = mk(arrB); arrAB = mk(arrA); flowB = mk(flowArr);
      idxB = mk(indices, gl.ELEMENT_ARRAY_BUFFER);
      vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      var bind = function (b, loc, size) { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
      bind(posB, aPos, 2); bind(uvB, aUv, 2); bind(gndB, aGnd, 1); bind(arrBB, aArrB, 1); bind(arrAB, aArrA, 1); bind(flowB, aFlow, 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxB); gl.bindVertexArray(null);
    },
    render: function (glc, mtxArg) {
      var mtx = (mtxArg && mtxArg.defaultProjectionData) ? mtxArg.defaultProjectionData.mainMatrix : mtxArg;
      var now = performance.now();
      stageCur += (stageTarget - stageCur) * 0.08;          // ไต่ระดับน้ำนุ่ม ๆ เมื่อเลื่อนสไลเดอร์
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uMat, false, mtx); gl.uniform1f(uTime, (now - t0) / 1000); gl.uniform1f(uM2, M2);
      gl.uniform1f(uStage, stageCur); gl.uniform1f(uSplit, uSplitX); gl.uniform1f(uFlowOn, flowOn);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1.0, -1.0);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.bindVertexArray(null);
      map.triggerRepaint();
    }
  };

  function leveeGeoJSON() {       // hull = "โซนที่ป้องกันได้" (ศักยภาพ) — แสดงตลอด (ไม่ใช่ตัวกำแพง)
    return { type: "FeatureCollection", features: IVCompare.levees().filter(function (l) { return l.polygon && l.polygon.length >= 3; }).map(function (l) {
      var ring = l.polygon.map(function (p) { return [p[0], p[1]]; }); ring.push(ring[0]);
      return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { on: IVCompare.isEnabled(l.rank) ? 1 : 0 } };
    }) };
  }

  // กำแพงคันกั้น 3D = ยกแท่งตามเซลล์ wall_cells จริง — แสดง "แนวที่เสนอ" ตลอด (เตี้ย) · เปิดมาตรการ → ยกเป็นกำแพงเต็ม
  function leveeWallGeoJSON() {
    if (!meta) meta = IVCompare.meta();
    var feats = [];
    IVCompare.levees().forEach(function (l) {
      if (!l.wall_cells) return;
      var on = IVCompare.isEnabled(l.rank) ? 1 : 0, h = l.wall_h_mean || 4;
      l.wall_cells.forEach(function (i) {
        var c = i % meta.NC, r = Math.floor(i / meta.NC);
        var lng = meta.OLON + (c + 0.5) * meta.DLON, lat = meta.OLAT - (r + 0.5) * meta.DLAT;
        feats.push({ type: "Feature", properties: { h: h, on: on }, geometry: { type: "Polygon", coordinates: [cellSquare(lng, lat)] } });
      });
    });
    return { type: "FeatureCollection", features: feats };
  }

  // วงแหวน (n-gon) รอบจุด รัศมีเป็นเมตร → ใช้ปั้นโมเดล extrusion ของท่อ/สูบ/บ่อหน่วง
  function makeRing(lng, lat, rM, n) {
    n = n || 28; var ring = [];
    var dLat = rM / 111320, dLng = rM / (111320 * Math.cos(lat * Math.PI / 180));
    for (var k = 0; k <= n; k++) { var a = k / n * 2 * Math.PI; ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
    return ring;
  }

  // สี่เหลี่ยมขนาดเซลล์ 30 ม. รอบศูนย์กลางเซลล์ (lng,lat) → วาดบ่อตามเซลล์ว่างจริง ไม่ทับอาคาร
  function cellSquare(lng, lat) {
    var hLng = meta.DLON / 2, hLat = meta.DLAT / 2;
    return [[lng - hLng, lat - hLat], [lng + hLng, lat - hLat], [lng + hLng, lat + hLat], [lng - hLng, lat + hLat], [lng - hLng, lat - hLat]];
  }

  // โมเดล 3D + หมุด HTML ของคอขวด (ท่อ/สูบ) และแก้มลิง — จาก intervention_candidates.geojson
  function buildCandidateMarkers() {
    if (!meta) meta = IVCompare.meta();
    fetch("data/intervention_candidates.geojson").then(function (r) { return r.json(); }).then(function (fc) {
      var bott = { type: "FeatureCollection", features: [] };   // สถานีสูบ/ท่อ = ฐาน + เสา
      var pond = { type: "FeatureCollection", features: [] };   // แก้มลิง = แอ่งน้ำตามเซลล์ว่างจริง
      (fc.features || []).forEach(function (f) {
        var p = f.properties || {}, g = f.geometry || {};
        if (g.type !== "Point") return;
        var lng = g.coordinates[0], lat = g.coordinates[1];
        if (p.kind === "bottleneck") {
          bott.features.push({ type: "Feature", properties: { h: 5, base: 0, color: "#9a3412" },
            geometry: { type: "Polygon", coordinates: [makeRing(lng, lat, 16, 8)] } });           // ฐานป้อมสูบ (เล็กลง ~1 เซลล์)
          bott.features.push({ type: "Feature", properties: { h: 30, base: 0, color: "#ea580c" },
            geometry: { type: "Polygon", coordinates: [makeRing(lng, lat, 7, 4)] } });            // เสา/อาคารสูบ
          addHtmlMarker(lng, lat, "bottleneck", "ti-windmill", "สูบ/ท่อ", p.label, p.rationale);
        } else if (p.kind === "retention") {
          // วาดบ่อจากเซลล์ว่างจริง (สี่เหลี่ยม 30 ม. ต่อเซลล์) → ไม่มีทางทับอาคาร; ถ้าไม่มีข้อมูลค่อย fallback วงกลม
          if (p.cells && p.cells.length) {
            p.cells.forEach(function (c) {
              pond.features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [cellSquare(c[0], c[1])] } });
            });
          } else {
            var rM = Math.sqrt((p.area_rai || 2) * 1600 / Math.PI);
            pond.features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [makeRing(lng, lat, rM, 24)] } });
          }
          addHtmlMarker(lng, lat, "retention", "ti-droplet", "แก้มลิง", p.label, p.rationale);
        }
      });
      // ---- คอขวด: ป้อมสูบ extrusion สีส้ม ----
      if (bott.features.length) {
        map.addSource("iv-bott", { type: "geojson", data: bott });
        map.addLayer({ id: "iv-bott-3d", type: "fill-extrusion", source: "iv-bott",
          paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "h"],
                   "fill-extrusion-base": ["get", "base"], "fill-extrusion-opacity": 0.92 } });
      }
      // ---- แก้มลิง: แอ่งน้ำตื้นสีเขียวมรกต + ขอบบ่อ ----
      if (pond.features.length) {
        map.addSource("iv-pond", { type: "geojson", data: pond });
        map.addLayer({ id: "iv-pond-3d", type: "fill-extrusion", source: "iv-pond",
          paint: { "fill-extrusion-color": "#0d9488", "fill-extrusion-height": 1.4, "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.5 } });
        map.addLayer({ id: "iv-pond-rim", type: "line", source: "iv-pond",
          paint: { "line-color": "#0f766e", "line-width": 2.5, "line-dasharray": [2, 1.5] } });
      }
    }).catch(function (e) { console.warn("3D candidates โหลดไม่ได้", e); });
  }

  // หมุด HTML (รองรับไทยเต็ม ไม่พึ่ง glyph) + popup อธิบายเหตุผล
  function addHtmlMarker(lng, lat, kind, icon, short, label, rationale) {
    var el = document.createElement("span");
    el.className = "iv3d-marker " + kind;
    el.innerHTML = '<i class="ti ' + icon + '"></i> ' + short;
    var pop = new maplibregl.Popup({ offset: 22, closeButton: false })
      .setHTML('<b>' + (label || short) + '</b><br>' + (rationale || ""));
    new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([lng, lat]).setPopup(pop).addTo(map);
  }

  function buildScene() {
    if (built) return; built = true;
    meta = IVCompare.meta();
    if (!map.getSource("terrain-dem")) {
      map.addSource("terrain-dem", { type: "raster-dem", tiles: ["terrain/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, minzoom: 12, maxzoom: 16 });
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.0 });
    }
    if (map.setSky) map.setSky({ "sky-color": "#bcd9f2", "horizon-color": "#eaf2fb", "fog-color": "#dce8f5", "fog-ground-blend": 0.4, "sky-horizon-blend": 0.6 });
    var HEIGHT_COLOR = ["interpolate", ["linear"], ["get", "height"], 6, "#cfe8ff", 9, "#9ec9f0", 12, "#f6c66b", 16, "#ef8e4d", 24, "#d6452e", 32, "#a02616"];
    fetch("data/yala_buildings.geojson").then(function (r) { return r.json(); }).then(function (bj) {
      if (map.getSource("iv-buildings")) return;
      map.addSource("iv-buildings", { type: "geojson", data: bj });
      map.addLayer({ id: "iv-buildings-3d", type: "fill-extrusion", source: "iv-buildings",
        paint: { "fill-extrusion-color": HEIGHT_COLOR, "fill-extrusion-height": ["coalesce", ["get", "height"], 8], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.92, "fill-extrusion-vertical-gradient": true } });
    }).catch(function (e) { console.warn("3D buildings โหลดไม่ได้", e); });
    // โซนที่ป้องกันได้ (hull) = ขอบเขตศักยภาพ — เส้นประบาง ไม่ใช่ตัวกำแพง
    map.addSource("iv-levees", { type: "geojson", data: leveeGeoJSON() });
    map.addLayer({ id: "iv-levees-fill", type: "fill", source: "iv-levees", paint: { "fill-color": ["case", ["==", ["get", "on"], 1], "rgba(59,130,246,0.12)", "rgba(59,130,246,0.05)"] } });
    map.addLayer({ id: "iv-levees-line", type: "line", source: "iv-levees", paint: { "line-color": "#2563eb", "line-width": 1.5, "line-dasharray": [3, 2], "line-opacity": 0.7 } });
    // กำแพงคันกั้น 3D จริง = แท่งตามเซลล์ wall_cells · ปิด=แนวเสนอเตี้ยจาง · เปิด=กำแพงเต็มสีคอนกรีต
    // (opacity ฝัง alpha ใน color เพราะ fill-extrusion-opacity ไม่รองรับ data-driven)
    map.addSource("iv-levee-wall", { type: "geojson", data: leveeWallGeoJSON() });
    map.addLayer({ id: "iv-levee-wall-3d", type: "fill-extrusion", source: "iv-levee-wall",
      paint: { "fill-extrusion-color": ["case", ["==", ["get", "on"], 1], "rgba(120,113,108,0.98)", "rgba(168,162,158,0.5)"],
               "fill-extrusion-height": ["case", ["==", ["get", "on"], 1], 5.0, 1.8],   // ความสูงโครงสร้างเพื่อมองเห็น (ตลิ่งจริงบน DEM ±5ม. วัดไม่ได้)
               "fill-extrusion-base": 0, "fill-extrusion-vertical-gradient": true } });
    buildCandidateMarkers();
    buildArrays();
    updateSplit();
    stageCur = stageTarget = IVCompare.getStage();
    map.addLayer(waterLayer);
  }

  function updateAfterBuffer() {
    if (!gl || !arrAB) return;
    var A = IVCompare.arrivals(), ff = IVCompare.flowField();
    for (var i = 0; i < N; i++) {
      arrA[i] = isFinite(A.after[i]) ? A.after[i] : 99999;
      flowArr[i * 2] = ff.fx[i]; flowArr[i * 2 + 1] = ff.fy[i];     // สนามการไหลเปลี่ยนตามคันกั้น → อ้อมสิ่งก่อสร้าง
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, arrAB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, arrA);
    gl.bindBuffer(gl.ARRAY_BUFFER, flowB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, flowArr);
    if (map.getSource("iv-levees")) map.getSource("iv-levees").setData(leveeGeoJSON());
    if (map.getSource("iv-levee-wall")) map.getSource("iv-levee-wall").setData(leveeWallGeoJSON());   // วาดกำแพง 3D ตามมาตรการที่เปิด
    if (map) map.triggerRepaint();
  }
  function updateSplit() { uSplitX = mercXOf(IVCompare.splitLon()); if (map) map.triggerRepaint(); }

  return {
    mount: function (el, _meta, onFail) {
      var loaded = false;
      try {
        map = new maplibregl.Map({
          container: el,
          style: { version: 8, glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
            sources: { osm: { type: "raster", tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap" } },
            layers: [{ id: "osm", type: "raster", source: "osm" }] },
          center: [101.293, 6.560], zoom: 13.6, pitch: 58, bearing: -22, maxZoom: 19
        });
      } catch (e) { console.warn("IV3D: สร้างแผนที่ 3D ไม่ได้", e); if (onFail) onFail(); return; }
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
      try { new ResizeObserver(function () { map.resize(); }).observe(el); } catch (e) {}
      map.on("error", function (e) { console.warn("IV3D map:", e && e.error && e.error.message); });
      map.on("load", function () { loaded = true; try { buildScene(); } catch (err) { console.warn("IV3D buildScene:", err && err.message); } });
      setTimeout(function () { if (!loaded && onFail) onFail(); }, 7000);    // ไม่มี WebGL2 → กลับมา 2D
    },
    onUpdate: function (kind) {
      if (kind === "after") updateAfterBuffer();
      else if (kind === "split") updateSplit();
      else if (kind === "stage") { stageTarget = IVCompare.getStage(); if (map) map.triggerRepaint(); }
    },
    setFlow: function (on) { flowOn = on ? 1.0 : 0.0; if (map) map.triggerRepaint(); },
    flyTo: function (lng, lat) { if (map) map.flyTo({ center: [lng, lat], zoom: 15.4, pitch: 56, essential: true }); },
    show: function () { if (map) setTimeout(function () { try { map.resize(); } catch (e) {} }, 60); },
    hide: function () {}
  };
})();
