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
  var htmlMarkers = {};
  var prog, vao, posB, uvB, gndB, arrBB, arrAB, flowB, drnB, drnBB2, fthB, idxB;
  var aPos, aUv, aGnd, aArrB, aArrA, aFlow, aDrn, aDrnB, aFth, uMat, uTime, uM2, uStage, uSplit, uFlowOn, uFeatherOn;
  var t0 = performance.now();
  var stageCur = 18.25, stageTarget = 18.25, uSplitX = 0, flowOn = 1.0;
  var featherOn = 0.0;             // เปิดคันกั้น → เกลี่ยน้ำฉากหลังนอกเขตให้จางเข้าหาเมือง (กันหน้าผาน้ำตรงเส้นเขต)
  var afterBufferDirty = false;
  var drains, drainArr, drainBaseArr, featherArr;

  function mercXOf(lng) { return maplibregl.MercatorCoordinate.fromLngLat({ lng: lng, lat: 6.547 }, 0).x; }

  function buildArrays() {
    meta = IVCompare.meta(); NC = meta.NC; NR = meta.NR; N = meta.N;
    var ar = IVCompare.arrays(), A = IVCompare.arrivals(), ground = ar.ground, ff = IVCompare.flowField();
    var inS = ar.inStudy, ctxA = A.ctx;    // น้ำฉากหลังนอกเขตเทศบาล (บริบท — เท่ากันทั้งก่อน/หลัง)
    drains = IVCompare.getDrain();
    M2 = maplibregl.MercatorCoordinate.fromLngLat({ lng: 101.285, lat: 6.547 }, 0).meterInMercatorCoordinateUnits();
    positions = new Float32Array(N * 2); uvs = new Float32Array(N * 2);
    grounds = new Float32Array(N); arrB = new Float32Array(N); arrA = new Float32Array(N); flowArr = new Float32Array(N * 2);
    drainArr = new Float32Array(N); drainBaseArr = new Float32Array(N); featherArr = new Float32Array(N);
    var cf = IVCompare.ctxFeather ? IVCompare.ctxFeather() : null;
    var drn0 = IVCompare.getBaseDrain ? IVCompare.getBaseDrain() : null;   // ระบายเดิม → ฝั่ง "ก่อน"
    for (var r = 0; r < NR; r++) for (var c = 0; c < NC; c++) {
      var i = r * NC + c, lng = meta.OLON + (c + 0.5) * meta.DLON, lat = meta.OLAT - (r + 0.5) * meta.DLAT;
      var p = maplibregl.MercatorCoordinate.fromLngLat({ lng: lng, lat: lat }, 0);
      positions[i * 2] = p.x; positions[i * 2 + 1] = p.y; uvs[i * 2] = (c + 0.5) / NC; uvs[i * 2 + 1] = (r + 0.5) / NR;
      grounds[i] = ground[i];
      var ctxV = (!inS[i] && ctxA && isFinite(ctxA[i])) ? ctxA[i] : 99999;   // นอกเขต → ใช้น้ำฉากหลัง
      arrB[i] = isFinite(A.base[i]) ? A.base[i] : ctxV;
      arrA[i] = isFinite(A.after[i]) ? A.after[i] : ctxV;
      flowArr[i * 2] = ff.fx[i]; flowArr[i * 2 + 1] = ff.fy[i];      // ทิศไหลใน uv-space (u=ตอ., v=ใต้)
      drainArr[i] = drains[i];
      drainBaseArr[i] = drn0 ? drn0[i] : 0;
      featherArr[i] = cf ? cf[i] : 1;
    }
    var idx = [];
    for (var rr = 0; rr < NR - 1; rr++) for (var cc = 0; cc < NC - 1; cc++) {
      var a = rr * NC + cc, b = a + 1, d = (rr + 1) * NC + cc, e = d + 1; idx.push(a, b, d, b, e, d);
    }
    indices = new Uint32Array(idx);
  }

  var VS = "attribute vec2 a_pos;attribute vec2 a_uv;attribute float a_ground;attribute float a_arrB;attribute float a_arrA;attribute vec2 a_flow;attribute float a_drain;attribute float a_drainB;attribute float a_feather;" +
    "uniform mat4 u_matrix;uniform float u_time;uniform float u_m2;uniform float u_stage;uniform float u_split;uniform float u_flowOn;uniform float u_featherOn;" +
    "varying float v_depth;varying vec3 v_n;varying vec2 v_uv;varying float v_flow;varying float v_edge;void main(){" +
    "float arr=(a_pos.x < u_split)?a_arrB:a_arrA;" +              /* ซ้าย=ก่อน, ขวา=หลัง */
    "float drn=(a_pos.x < u_split)?a_drainB:a_drain;" +           /* ก่อน=ระบายเดิม, หลัง=รวมมาตรการที่เปิด */
    "float depth=(arr<=u_stage)?max(0.0,u_stage-a_ground-drn):0.0;" +
    "depth*=mix(1.0,a_feather,u_featherOn);" +                    /* เปิดคันกั้น → น้ำฉากหลังตื้นลงเข้าหาเมือง (ไม่เป็นหน้าผา) */
    /* จางเข้าหาขอบกริด DEM (~8% ของกริด) — ส่งไปคูณ "alpha" ใน FS ด้วย (คูณแค่ depth ไม่พอ
       เพราะ alpha มีค่าตั้งต้น ~0.42 ทันทีที่ depth>0.03 → ขอบยังตัดคม + foam ทำขอบขาว) */
    "float ef=smoothstep(0.0,0.08,min(min(a_uv.x,1.0-a_uv.x),min(a_uv.y,1.0-a_uv.y)));" +
    "depth*=ef;v_edge=ef;" +
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
  var FS = "precision highp float;varying float v_depth;varying vec3 v_n;varying vec2 v_uv;varying float v_flow;varying float v_edge;uniform float u_time;void main(){" +
    "if(v_depth<0.03)discard;float dn=clamp(v_depth/2.5,0.0,1.0);" +
    "vec3 col=mix(vec3(0.32,0.64,0.82),vec3(0.02,0.18,0.42),dn);" +
    "vec3 N=normalize(v_n),V=vec3(0.0,0.0,1.0),L=normalize(vec3(0.55,0.35,0.78)),H=normalize(L+V);" +
    "float spec=pow(max(dot(N,H),0.0),55.0);float fres=pow(1.0-max(dot(N,V),0.0),4.0);" +
    "col=mix(col,vec3(0.62,0.80,0.95),fres*0.55);col+=vec3(1.0,0.97,0.85)*spec*0.7;" +
    "float foam=(1.0-smoothstep(0.03,0.35,v_depth))*0.55;col=mix(col,vec3(0.92,0.97,1.0),foam*0.6);" +
    "col=mix(col,vec3(0.80,0.92,1.0),clamp(v_flow,0.0,1.0)*0.16);" +     /* ริ้วการไหล */
    "float a=(mix(0.42,0.9,dn)+spec*0.35+foam*0.25)*v_edge;gl_FragColor=vec4(col,clamp(a,0.0,0.96));}";   /* ×v_edge → ผืนน้ำจางหายก่อนถึงขอบกริด ไม่ตัดเป็นเส้น */

  var waterLayer = {
    id: "iv-water3d", type: "custom", renderingMode: "3d",
    onAdd: function (_m, glc) {
      gl = glc;
      var sh = function (t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) console.error("iv-water:", gl.getShaderInfoLog(o)); return o; };
      prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error("iv-water link:", gl.getProgramInfoLog(prog));
      aPos = gl.getAttribLocation(prog, "a_pos"); aUv = gl.getAttribLocation(prog, "a_uv");
      aGnd = gl.getAttribLocation(prog, "a_ground"); aArrB = gl.getAttribLocation(prog, "a_arrB"); aArrA = gl.getAttribLocation(prog, "a_arrA"); aFlow = gl.getAttribLocation(prog, "a_flow");
      aDrn = gl.getAttribLocation(prog, "a_drain"); aDrnB = gl.getAttribLocation(prog, "a_drainB"); aFth = gl.getAttribLocation(prog, "a_feather");
      uMat = gl.getUniformLocation(prog, "u_matrix"); uTime = gl.getUniformLocation(prog, "u_time");
      uM2 = gl.getUniformLocation(prog, "u_m2"); uStage = gl.getUniformLocation(prog, "u_stage"); uSplit = gl.getUniformLocation(prog, "u_split"); uFlowOn = gl.getUniformLocation(prog, "u_flowOn");
      uFeatherOn = gl.getUniformLocation(prog, "u_featherOn");
      var mk = function (data, type) { var b = gl.createBuffer(); gl.bindBuffer(type || gl.ARRAY_BUFFER, b); gl.bufferData(type || gl.ARRAY_BUFFER, data, type ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW); return b; };
      posB = mk(positions); uvB = mk(uvs); gndB = mk(grounds);
      arrBB = mk(arrB); arrAB = mk(arrA); flowB = mk(flowArr); drnB = mk(drainArr); drnBB2 = mk(drainBaseArr); fthB = mk(featherArr);
      idxB = mk(indices, gl.ELEMENT_ARRAY_BUFFER);
      vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      var bind = function (b, loc, size) { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
      bind(posB, aPos, 2); bind(uvB, aUv, 2); bind(gndB, aGnd, 1); bind(arrBB, aArrB, 1); bind(arrAB, aArrA, 1); bind(flowB, aFlow, 2); bind(drnB, aDrn, 1); bind(drnBB2, aDrnB, 1); bind(fthB, aFth, 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxB); gl.bindVertexArray(null);
    },
    render: function (glc, mtxArg) {
      var mtx = (mtxArg && mtxArg.defaultProjectionData) ? mtxArg.defaultProjectionData.mainMatrix : mtxArg;
      var now = performance.now();
      if (afterBufferDirty && gl) {
        afterBufferDirty = false;
        gl.bindBuffer(gl.ARRAY_BUFFER, arrAB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, arrA);
        gl.bindBuffer(gl.ARRAY_BUFFER, flowB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, flowArr);
        gl.bindBuffer(gl.ARRAY_BUFFER, drnB); gl.bufferSubData(gl.ARRAY_BUFFER, 0, drainArr);
      }
      stageCur += (stageTarget - stageCur) * 0.08;          // ไต่ระดับน้ำนุ่ม ๆ เมื่อเลื่อนสไลเดอร์
      gl.useProgram(prog);
      gl.uniformMatrix4fv(uMat, false, mtx); gl.uniform1f(uTime, (now - t0) / 1000); gl.uniform1f(uM2, M2);
      gl.uniform1f(uStage, stageCur); gl.uniform1f(uSplit, uSplitX); gl.uniform1f(uFlowOn, flowOn);
      gl.uniform1f(uFeatherOn, featherOn);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      /* ห้ามใช้ depth test: depth ของ terrain mesh ขัดกับผิวน้ำ (คลาดจาก DEM + LOD สลับตอนกล้องเคลื่อน)
         ทำให้น้ำโดนบังเป็นริ้ว/กระพริบ — เกิดแม้กล้องนิ่งในบางมุม · น้ำโปร่งแสงวาดท้ายสุด blend ทับตรง ๆ */
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
      gl.depthMask(true); gl.bindVertexArray(null);
      map.triggerRepaint();
    }
  };

  // (เดิมมี hull "โซนป้องกันได้" เส้นประสีฟ้าทับเมือง — เอาออก: ขอบเหลี่ยมของ hull ทำให้ดูเหมือน
  //  น้ำถูกตัดด้วยโพลิกอน · กำแพงคันกั้น 3D ตามแนวจริง + เมืองที่แห้งลง สื่อผลป้องกันชัดกว่า)

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
    var hLng = (meta.DLON / 2) * 1.15, hLat = (meta.DLAT / 2) * 1.15;
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
          addHtmlMarker(lng, lat, "bottleneck", "ti-windmill", "สูบ/ท่อ", p.label, p.rationale, p.design_req, p.std);
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
          addHtmlMarker(lng, lat, "retention", "ti-droplet", "แก้มลิง", p.label, p.rationale, p.design_req, p.std);
        } else if (p.kind === "floodgate") {
          addHtmlMarker(lng, lat, "floodgate", "ti-door", "ประตู/สูบ", p.label, p.rationale, p.design_req, p.std);
        }
      });
      // ---- คอขวด: ป้อมสูบ extrusion สีส้ม ----
      if (bott.features.length) {
        map.addSource("iv-bott", { type: "geojson", data: bott });
        map.addLayer({ id: "iv-bott-3d", type: "fill-extrusion", source: "iv-bott",
          layout: { visibility: "none" },
          paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "h"],
                   "fill-extrusion-base": ["get", "base"], "fill-extrusion-opacity": 0.92 } });
      }
      // ---- แก้มลิง: แอ่งน้ำตื้นสีเขียวมรกต + ขอบบ่อ ----
      if (pond.features.length) {
        map.addSource("iv-pond", { type: "geojson", data: pond });
        map.addLayer({ id: "iv-pond-3d", type: "fill-extrusion", source: "iv-pond",
          layout: { visibility: "none" },
          paint: { "fill-extrusion-color": "#0d9488", "fill-extrusion-height": 1.4, "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.5 } });
        map.addLayer({ id: "iv-pond-rim", type: "line", source: "iv-pond",
          layout: { visibility: "none" },
          paint: { "line-color": "#0f766e", "line-width": 2.5, "line-dasharray": [2, 1.5] } });
      }
    }).catch(function (e) { console.warn("3D candidates โหลดไม่ได้", e); });
  }

  // หมุด HTML (รองรับไทยเต็ม ไม่พึ่ง glyph) + popup อธิบายเหตุผล + checklist องค์ประกอบที่ต้องมี
  function reqHtml(req, std) {
    if (!req || !req.length) return "";
    var items = req.map(function (x) { return "<li>" + x + "</li>"; }).join("");
    return '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e7eb;">'
      + '<div style="font-size:10.5px;font-weight:700;color:#7c3aed;">องค์ประกอบที่ต้องมี (' + (std || "") + ')</div>'
      + '<ul style="margin:3px 0 0;padding-left:16px;font-size:10.5px;color:#475569;line-height:1.5;">' + items + '</ul></div>';
  }
  function addHtmlMarker(lng, lat, kind, icon, short, label, rationale, req, std) {
    var el = document.createElement("span");
    el.className = "iv3d-marker " + kind;
    el.innerHTML = '<i class="ti ' + icon + '"></i> ' + short;
    var pop = new maplibregl.Popup({ offset: 22, closeButton: false })
      .setHTML('<b>' + (label || short) + '</b><br>' + (rationale || "") + reqHtml(req, std));
    var marker = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([lng, lat]).setPopup(pop);
    if (!htmlMarkers[kind]) htmlMarkers[kind] = [];
    htmlMarkers[kind].push(marker);
    // ไม่ addTo(map) ตั้งแต่แรก — รอ toggleKind(kind, true)
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
    fetch("data/yala_buildings.geojson?t=" + Date.now()).then(function (r) { return r.json(); }).then(function (bj) {
      if (map.getSource("iv-buildings")) return;
      map.addSource("iv-buildings", { type: "geojson", data: bj });
      map.addLayer({ id: "iv-buildings-3d", type: "fill-extrusion", source: "iv-buildings",
        paint: { "fill-extrusion-color": HEIGHT_COLOR, "fill-extrusion-height": ["coalesce", ["get", "height"], 8], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.92, "fill-extrusion-vertical-gradient": true } });
    }).catch(function (e) { console.warn("3D buildings โหลดไม่ได้", e); });
    // กำแพงคันกั้น 3D จริง = แท่งตามเซลล์ wall_cells · ปิด=แนวเสนอเตี้ยจาง · เปิด=กำแพงเต็มสีคอนกรีต
    // (opacity ฝัง alpha ใน color เพราะ fill-extrusion-opacity ไม่รองรับ data-driven)
    map.addSource("iv-levee-wall", { type: "geojson", data: leveeWallGeoJSON() });
    // Main Wall (Warm Stone/Concrete White)
    map.addLayer({ id: "iv-levee-wall-3d", type: "fill-extrusion", source: "iv-levee-wall",
      layout: { visibility: "none" },
      paint: { "fill-extrusion-color": ["case", ["==", ["get", "on"], 1], "#e7e5e4", "#d6d3d1"],
               "fill-extrusion-height": ["case", ["==", ["get", "on"], 1], 4.5, 1.5],
               "fill-extrusion-base": 0, "fill-extrusion-vertical-gradient": true } });
    // Top Cap (Dark Charcoal)
    map.addLayer({ id: "iv-levee-wall-cap-3d", type: "fill-extrusion", source: "iv-levee-wall",
      layout: { visibility: "none" },
      paint: { "fill-extrusion-color": ["case", ["==", ["get", "on"], 1], "#44403c", "#78716c"],
               "fill-extrusion-height": ["case", ["==", ["get", "on"], 1], 4.8, 1.7],
               "fill-extrusion-base": ["case", ["==", ["get", "on"], 1], 4.5, 1.5],
               "fill-extrusion-vertical-gradient": false } });
    buildCanals3D();
    buildCandidateMarkers();
    buildArrays();
    updateSplit();
    stageCur = stageTarget = IVCompare.getStage();
    featherOn = 0.0;   // arrival เต็มกริดทั้งก่อน/หลังแล้ว — ไม่มีรอยต่อเขตให้เกลี่ยอีก (หน้าผาน้ำที่กำแพง = ของจริง)
    map.addLayer(waterLayer);
  }

  // คลองระบายน้ำเส้นใหม่ 3D — เส้นสีฟ้าเข้ม (ซ่อนไว้ก่อน · toggleCanal เปิด/ปิด)
  function buildCanals3D() {
    var routes = IVCompare.canals ? IVCompare.canals() : [];
    if (!routes.length || map.getSource("iv-canal")) return;
    var fc = { type: "FeatureCollection", features: routes.map(function (rt, i) {
      return { type: "Feature", properties: { n: i + 1, len: rt.length_m },
        geometry: { type: "LineString", coordinates: rt.line.map(function (p) { return [p[0], p[1]]; }) } };
    }) };
    map.addSource("iv-canal", { type: "geojson", data: fc });
    map.addLayer({ id: "iv-canal-case", type: "line", source: "iv-canal", layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 } });
    map.addLayer({ id: "iv-canal-line", type: "line", source: "iv-canal", layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0891b2", "line-width": 4 } });
  }

  function updateAfterBuffer() {
    var A = IVCompare.arrivals(), ff = IVCompare.flowField(), drn = IVCompare.getDrain();
    var inS = IVCompare.arrays().inStudy, ctxA = A.ctx;
    for (var i = 0; i < N; i++) {
      arrA[i] = isFinite(A.after[i]) ? A.after[i]
        : ((!inS[i] && ctxA && isFinite(ctxA[i])) ? ctxA[i] : 99999);       // นอกเขต → น้ำฉากหลังคงเดิม
      flowArr[i * 2] = ff.fx[i]; flowArr[i * 2 + 1] = ff.fy[i];     // สนามการไหลเปลี่ยนตามคันกั้น → อ้อมสิ่งก่อสร้าง
      drainArr[i] = drn[i];
    }
    afterBufferDirty = true;
    featherOn = 0.0;   // ผืนน้ำเดียวทั้งกริด — ไม่ต้องเกลี่ยรอยต่อเขตอีก
    if (map.getSource("iv-levee-wall")) map.getSource("iv-levee-wall").setData(leveeWallGeoJSON());   // วาดกำแพง 3D ตามมาตรการที่เปิด
    if (map) map.triggerRepaint();
  }
  function updateSplit() { uSplitX = mercXOf(IVCompare.splitLon()); if (map) map.triggerRepaint(); }

  return {
    mount: function (el, _meta, onFail, onReady) {
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
      map.on("load", function () { loaded = true; try { buildScene(); if (onReady) onReady(); } catch (err) { console.warn("IV3D buildScene:", err && err.message); } });
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
    hide: function () {},
    toggleCanal: function (visible) {
      if (!map) return;
      ["iv-canal-case", "iv-canal-line"].forEach(function (id) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      });
    },
    toggleKind: function (kind, visible) {
      if (!map) return;
      if (htmlMarkers[kind]) {
        htmlMarkers[kind].forEach(function (m) { if (visible) m.addTo(map); else m.remove(); });
      }
      var layerIds = {
        levee: ["iv-levee-wall-3d", "iv-levee-wall-cap-3d"],
        bottleneck: ["iv-bott-3d"],
        retention: ["iv-pond-3d", "iv-pond-rim"],
        floodgate: []
      };
      (layerIds[kind] || []).forEach(function (id) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      });
    }
  };
})();
