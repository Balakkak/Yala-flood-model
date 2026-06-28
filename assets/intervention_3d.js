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
  var positions, uvs, grounds, arrB, arrA, indices, M2, N, NC, NR;
  var prog, vao, posB, uvB, gndB, arrBB, arrAB, drnB, idxB;
  var aPos, aUv, aGnd, aArrB, aArrA, uMat, uTime, uM2, uStage, uSplit;
  var t0 = performance.now(), uSplitX = 1e9, STAGE = 18.25;

  function mercXOf(lng) { return maplibregl.MercatorCoordinate.fromLngLat({ lng: lng, lat: 6.547 }, 0).x; }

  function buildArrays() {
    meta = IVCompare.meta(); NC = meta.NC; NR = meta.NR; N = meta.N; STAGE = meta.STAGE;
    var ar = IVCompare.arrays(), A = IVCompare.arrivals(), ground = ar.ground;
    M2 = maplibregl.MercatorCoordinate.fromLngLat({ lng: 101.285, lat: 6.547 }, 0).meterInMercatorCoordinateUnits();
    positions = new Float32Array(N * 2); uvs = new Float32Array(N * 2);
    grounds = new Float32Array(N); arrB = new Float32Array(N); arrA = new Float32Array(N);
    for (var r = 0; r < NR; r++) for (var c = 0; c < NC; c++) {
      var i = r * NC + c, lng = meta.OLON + (c + 0.5) * meta.DLON, lat = meta.OLAT - (r + 0.5) * meta.DLAT;
      var p = maplibregl.MercatorCoordinate.fromLngLat({ lng: lng, lat: lat }, 0);
      positions[i * 2] = p.x; positions[i * 2 + 1] = p.y; uvs[i * 2] = (c + 0.5) / NC; uvs[i * 2 + 1] = (r + 0.5) / NR;
      grounds[i] = ground[i];
      arrB[i] = isFinite(A.base[i]) ? A.base[i] : 99999;
      arrA[i] = isFinite(A.after[i]) ? A.after[i] : 99999;
    }
    var idx = [];
    for (var rr = 0; rr < NR - 1; rr++) for (var cc = 0; cc < NC - 1; cc++) {
      var a = rr * NC + cc, b = a + 1, d = (rr + 1) * NC + cc, e = d + 1; idx.push(a, b, d, b, e, d);
    }
    indices = new Uint32Array(idx);
  }

  var VS = "attribute vec2 a_pos;attribute vec2 a_uv;attribute float a_ground;attribute float a_arrB;attribute float a_arrA;" +
    "uniform mat4 u_matrix;uniform float u_time;uniform float u_m2;uniform float u_stage;uniform float u_split;" +
    "varying float v_depth;varying vec3 v_n;varying vec2 v_uv;void main(){" +
    "float arr=(a_pos.x < u_split)?a_arrB:a_arrA;" +              /* ซ้าย=ก่อน, ขวา=หลัง */
    "float depth=(arr<=u_stage)?max(0.0,u_stage-a_ground):0.0;" +
    "float amp=clamp(depth*2.0,0.0,1.0);vec2 g=a_uv*48.0;" +
    "vec2 d1=vec2(0.30,0.95),d2=vec2(0.82,0.28),d3=vec2(-0.55,0.70);" +
    "float p1=dot(g,d1)+u_time*0.72;float p2=dot(g,d2)*1.5+u_time*0.50;float p3=dot(g,d3)*2.2+u_time*0.92;" +
    "float w=0.038*sin(p1)+0.022*sin(p2)+0.012*sin(p3);" +
    "vec2 gr=0.038*cos(p1)*d1+0.022*cos(p2)*d2*1.5+0.012*cos(p3)*d3*2.2;" +
    "float surf=max(depth+w*amp,0.02);v_n=normalize(vec3(-gr*amp,1.0));v_depth=depth;v_uv=a_uv;" +
    "float z=(a_ground+surf)*u_m2;gl_Position=u_matrix*vec4(a_pos,z,1.0);}";
  var FS = "precision highp float;varying float v_depth;varying vec3 v_n;varying vec2 v_uv;uniform float u_time;void main(){" +
    "if(v_depth<0.03)discard;float dn=clamp(v_depth/2.5,0.0,1.0);" +
    "vec3 col=mix(vec3(0.32,0.64,0.82),vec3(0.02,0.18,0.42),dn);" +
    "vec3 N=normalize(v_n),V=vec3(0.0,0.0,1.0),L=normalize(vec3(0.55,0.35,0.78)),H=normalize(L+V);" +
    "float spec=pow(max(dot(N,H),0.0),55.0);float fres=pow(1.0-max(dot(N,V),0.0),4.0);" +
    "col=mix(col,vec3(0.62,0.80,0.95),fres*0.55);col+=vec3(1.0,0.97,0.85)*spec*0.7;" +
    "float foam=(1.0-smoothstep(0.03,0.35,v_depth))*0.55;col=mix(col,vec3(0.92,0.97,1.0),foam*0.6);" +
    "float a=mix(0.42,0.9,dn)+spec*0.35+foam*0.25;gl_FragColor=vec4(col,clamp(a,0.0,0.96));}";

  var waterLayer = {
    id: "iv-water3d", type: "custom", renderingMode: "3d",
    onAdd: function (_m, glc) {
      gl = glc;
      var sh = function (t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.error("iv-water:", gl.getShaderInfoLog(o)); return o; };
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error("iv-water link:", gl.getProgramInfoLog(prog));
      aPos = gl.getAttribLocation(prog, "a_pos"); aUv = gl.getAttribLocation(prog, "a_uv");
      aGnd = gl.getAttribLocation(prog, "a_ground"); aArrB = gl.getAttribLocation(prog, "a_arrB"); aArrA = gl.getAttribLocation(prog, "a_arrA");
      uMat = gl.getUniformLocation(prog, "u_matrix"); uTime = gl.getUniformLocation(prog, "u_time");
      uM2 = gl.getUniformLocation(prog, "u_m2"); uStage = gl.getUniformLocation(prog, "u_stage"); uSplit = gl.getUniformLocation(prog, "u_split");
      var mk = function (data, type) { var b = gl.createBuffer(); gl.bindBuffer(type || gl.ARRAY_BUFFER, b); gl.bufferData(type || gl.ARRAY_BUFFER, data, type ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW); return b; };
      posB = mk(positions); uvB = mk(uvs); gndB = mk(grounds);
      arrBB = mk(arrB); arrAB = mk(arrA);
      idxB = mk(indices, gl.ELEMENT_ARRAY_BUFFER);
      vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      var bind = function (b, loc, size) { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
      bind(posB, aPos, 2); bind(uvB, aUv, 2); bind(gndB, aGnd, 1); bind(arrBB, aArrB, 1); bind(arrAB, aArrA, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxB); gl.bindVertexArray(null);
    },
    render: function (glc, mtxArg) {
      var mtx = (mtxArg && mtxArg.defaultProjectionData) ? mtxArg.defaultProjectionData.mainMatrix : mtxArg;
      var now = performance.now();
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uMat, false, mtx); gl.uniform1f(uTime, (now - t0) / 1000); gl.uniform1f(uM2, M2);
      gl.uniform1f(uStage, STAGE); gl.uniform1f(uSplit, uSplitX);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1.0, -1.0);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.bindVertexArray(null);
      map.triggerRepaint();
    }
  };

  function leveeGeoJSON() {
    return { type: "FeatureCollection", features: IVCompare.levees().filter(function (l) { return IVCompare.isEnabled(l.rank) && l.polygon && l.polygon.length >= 3; }).map(function (l) {
      var ring = l.polygon.map(function (p) { return [p[0], p[1]]; }); ring.push(ring[0]);
      return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
    }) };
  }

  function buildScene() {
    if (built) return; built = true;
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
    // เส้นคันกั้นที่เปิดใช้งาน
    map.addSource("iv-levees", { type: "geojson", data: leveeGeoJSON() });
    map.addLayer({ id: "iv-levees-line", type: "line", source: "iv-levees", paint: { "line-color": "#1d4ed8", "line-width": 3 } });
    map.addLayer({ id: "iv-levees-fill", type: "fill", source: "iv-levees", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.12 } });
    buildArrays();
    updateSplit();
    map.addLayer(waterLayer);
  }

  function updateAfterBuffer() {
    if (!gl || !arrAB) return;
    var A = IVCompare.arrivals();
    for (var i = 0; i < N; i++) arrA[i] = isFinite(A.after[i]) ? A.after[i] : 99999;
    gl.bindBuffer(gl.ARRAY_BUFFER, arrAB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, arrA);
    if (map.getSource("iv-levees")) map.getSource("iv-levees").setData(leveeGeoJSON());
    if (map) map.triggerRepaint();
  }
  function updateSplit() { uSplitX = mercXOf(IVCompare.splitLon()); if (map) map.triggerRepaint(); }

  function showFallback(el) {
    if (el.querySelector(".iv3d-fallback")) return;
    var f = document.createElement("div");
    f.className = "iv3d-fallback";
    f.style.cssText = "position:absolute;inset:0;z-index:2;display:grid;place-items:center;text-align:center;padding:24px;background:#f8fafc;color:#475569;font:500 13px Sarabun,sans-serif;line-height:1.6;";
    f.innerHTML = '<div><i class="ti ti-cube-off" style="font-size:30px;color:#94a3b8;"></i>' +
      '<p style="margin:10px 0 4px;font-weight:700;color:#334155;">มุมมอง 3D ต้องใช้ WebGL2</p>' +
      '<p style="margin:0 0 12px;max-width:340px;">เบราว์เซอร์/สภาพแวดล้อมนี้ยังไม่รองรับ WebGL2 — ใช้มุมมอง <b>2D</b> เปรียบเทียบได้เต็มรูปแบบ ' +
      'หรือเปิดเมืองจำลอง 3D เต็มหน้าจอ</p>' +
      '<a href="index.html" target="_blank" style="display:inline-block;background:#0c3b6e;color:#fff;text-decoration:none;font-weight:600;padding:7px 16px;border-radius:8px;">เปิดเมือง 3D เต็มหน้าจอ</a></div>';
    el.appendChild(f);
  }
  return {
    mount: function (el) {
      var loaded = false;
      try {
        map = new maplibregl.Map({
          container: el,
          style: { version: 8, glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
            sources: { osm: { type: "raster", tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png", "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap" } },
            layers: [{ id: "osm", type: "raster", source: "osm" }] },
          center: [101.293, 6.560], zoom: 13.6, pitch: 58, bearing: -22, maxZoom: 19
        });
      } catch (e) { console.warn("IV3D: สร้างแผนที่ 3D ไม่ได้", e); showFallback(el); return; }
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
      try { new ResizeObserver(function () { map.resize(); }).observe(el); } catch (e) {}
      map.on("error", function (e) { console.warn("IV3D map:", e && e.error && e.error.message); });
      map.on("load", function () { loaded = true; try { buildScene(); } catch (err) { console.warn("IV3D buildScene:", err && err.message); } });
      setTimeout(function () { if (!loaded) showFallback(el); }, 7000);    // ไม่รองรับ WebGL2 → fallback
    },
    onUpdate: function (kind) { if (kind === "after") updateAfterBuffer(); else if (kind === "split") updateSplit(); },
    show: function () { if (map) setTimeout(function () { try { map.resize(); } catch (e) {} }, 60); },
    hide: function () {}
  };
})();
