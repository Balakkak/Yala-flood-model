/* ============================================================================
 * intervention_views.js — UI/renderer ของเครื่องเปรียบเทียบ ก่อน–หลังสร้าง
 * ----------------------------------------------------------------------------
 * ทำงานคู่กับ IVCompare (engine) :
 *   - 2D : วาด depth grid ลง canvas → L.imageOverlay บนแผนที่ Leaflet (มี dried = เขียว)
 *   - 3D : MapLibre custom WebGL water (เติมใน mount3D — Stage 3)
 *   - swipe เดียวคุมทั้งสองมุมมอง (split 0..1) + ปุ่ม ก่อน/เทียบ/หลัง
 *   - คุมมาตรการ (toggle คันกั้นแต่ละจุด) + แสดงสถิติ ก่อน→หลัง + ลดลง
 * ========================================================================== */
window.IVViews = (function () {
  "use strict";
  var L, lmap, meta, NC, NR;
  var canvas, ctx, floodOverlay, canalLayer = null, canalOn = false;
  var mount3dFn = null, view = "2d";

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(n).toLocaleString(); };
  var applyLevelFn = null;

  // ---- สีตามความลึก (0→3 ม.) : ฟ้าอ่อน → ฟ้า → กรมท่า ----
  function lerp(a, b, t) { return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]; }
  var C0 = [186, 230, 253], C1 = [56, 189, 248], C2 = [12, 74, 110];
  function depthColor(d) {
    var t = Math.max(0, Math.min(1, d / 3));
    return t < 0.5 ? lerp(C0, C1, t / 0.5) : lerp(C1, C2, (t - 0.5) / 0.5);
  }

  // ================= 2D =================
  // วาดน้ำ "ผืนเดียวทั้งกริด" (โมเดล/สถิติคิดรวมทั้งเมือง ไม่แยกน้ำฉากบริบทนอกเขตอีก — น้ำไม่เลือกเขต)
  function draw2D() {
    if (!ctx) return;
    var A = IVCompare.arrivals(), base = A.base, after = A.after;
    var ar = IVCompare.arrays(), chan = ar.chanMask;
    var st = IVCompare.getStage(), split = IVCompare.getSplit(), splitCol = split * NC;
    var drain = IVCompare.getDrain();     // ความจุระบายจากมาตรการที่เปิด (แก้มลิง/คอขวด) → ฝั่ง "หลัง"
    var drain0 = IVCompare.getBaseDrain ? IVCompare.getBaseDrain() : null;   // ระบายเดิมของเมือง → ฝั่ง "ก่อน" (สอดคล้องสถิติ)
    var img = ctx.createImageData(NC, NR), d = img.data;
    for (var r = 0; r < NR; r++) for (var c = 0; c < NC; c++) {
      var i = r * NC + c, o = i * 4;
      if (chan[i]) { d[o + 3] = 0; continue; }
      // จางเข้าหาขอบกริด DEM (~18 เซลล์) — กันผืนน้ำถูกตัดเป็นเส้นตรงตามขอบข้อมูล
      var f = Math.min(1, Math.min(Math.min(r, NR - 1 - r), Math.min(c, NC - 1 - c)) / 18);
      if (f <= 0.04) { d[o + 3] = 0; continue; }
      var d0 = drain0 ? drain0[i] : 0;
      var useBefore = c < splitCol;
      var arr = useBefore ? base[i] : after[i];
      var dep = st - arr - (useBefore ? d0 : drain[i]);   // ทั้งสองฝั่งหักระบายเดิม · ฝั่งหลังหักของมาตรการเพิ่ม
      if (dep > 0.03) {
        var col = depthColor(dep);
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = Math.round(200 * f);
      } else if (!useBefore && st - base[i] - d0 > 0.03) {
        d[o] = 52; d[o + 1] = 211; d[o + 2] = 153; d[o + 3] = Math.round(150 * f);   // ท่วมตอน "ก่อน" แต่แห้งเพราะมาตรการ = เขียว
      } else { d[o + 3] = 0; }
    }
    ctx.putImageData(img, 0, 0);
    floodOverlay.setUrl(canvas.toDataURL());
  }

  // (เดิมมีโพลิกอน "โซนป้องกันได้" สีฟ้าเส้นประทับเมือง — เอาออก เพราะขอบเหลี่ยม ๆ ของ hull
  //  ทำให้ดูเหมือนน้ำถูกตัดด้วยโพลิกอน · แนวกำแพงจริง (เส้นเทา 2D / กำแพง 3D) + พื้นที่เขียว
  //  "แห้งลงหลังมีมาตรการ" สื่อผลป้องกันอยู่แล้ว)

  // ---- หลอดผลรวม (การ์ดใต้ "วิธีวิเคราะห์") — สเกล 100% ของปริมาตรน้ำท่วมก่อนมาตรการ:
  //      ฝั่งซ้ายแดง = % ที่ยังท่วมอยู่ · ฝั่งขวาเขียว = % ที่มาตรการที่เปิดรวมกันลดได้ ----
  function updateTotalGauge(s, total) {
    var red = $("totRed"), green = $("totGreen"), cnt = $("totCount"), det = $("totDetail");
    if (!red || !s) return;
    var pct = Math.max(0, Math.min(100, s.reduced.volume_pct || 0));
    if (total === 0) pct = 0;
    var flooded = s.before.volume_m3 > 0;
    var remain = flooded ? Math.round((100 - pct) * 10) / 10 : 0;
    red.style.width = (flooded ? remain : 0) + "%";
    green.style.width = (flooded ? pct : 0) + "%";
    $("totLeft").textContent = remain + "%";
    $("totRight").textContent = pct + "%";
    cnt.textContent = total + " มาตรการ";
    if (!flooded) det.innerHTML = 'ยังไม่มีน้ำท่วมที่ระดับนี้ — กด <b>จำลองน้ำท่วม</b> เพื่อดูผล';
    else if (total === 0) det.innerHTML = 'ยังไม่เปิดมาตรการ — ติ๊กมาตรการด้านล่างเพื่อดูผลรวม';
    else det.innerHTML = 'ลดปริมาตรน้ำท่วม ~<b>' + fmt(Math.max(0, s.reduced.volume_m3)) + ' ลบ.ม.</b>' +
      ' · อาคารพ้นน้ำ ~<b>' + fmt(Math.max(0, s.reduced.buildings)) + ' หลัง</b>' +
      ' · พื้นที่แห้งลง ~<b>' + fmt(Math.max(0, s.reduced.area_rai)) + ' ไร่</b>' +
      ' <span style="color:#94a3b8;">· นับน้ำท่วมทั้งพื้นที่บนแผนที่ ไม่จำกัดเขต</span>';
  }

  // ---- แถวมาตรการโชว์แค่ชื่อ — ปุ่มลูกศรมุมขวากางรายละเอียด (กันสับสนกับการติ๊ก) ----
  function decorateRow(el) {
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "tog-more"; btn.title = "ดูรายละเอียดมาตรการ";
    btn.innerHTML = '<i class="ti ti-chevron-down"></i>';
    btn.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();   // อย่าให้ label ติ๊ก checkbox
      el.classList.toggle("expanded");
    });
    el.appendChild(btn);
  }

  // ================= ผลของมาตรการ (ป้องกันได้เท่าไร เมื่อเทียบกับไม่มีโครงสร้าง) =================
  function updateStats() {
    var s = IVCompare.stats(); if (!s) return;
    var nLevee = IVCompare.enabledCount();
    var nInfo = IVCompare.infoEnabledCount ? IVCompare.infoEnabledCount() : 0;
    var ex = IVCompare.extras ? IVCompare.extras() : { pump: false, dredge: false };
    var nExtra = (ex.pump ? 1 : 0) + (ex.dredge ? 1 : 0);
    var canals = (canalOn && IVCompare.canals) ? IVCompare.canals() : [];
    var nCanal = canalOn ? 1 : 0;
    var res = $("protResult");
    res.style.display = "block";
    var total = nLevee + nInfo + nExtra + nCanal;
    updateTotalGauge(s, total);
    if (total === 0) {
      res.className = "prot-result none";
      res.innerHTML = '<i class="ti ti-info-circle"></i> ยังไม่เปิดมาตรการ — น้ำท่วมเต็มตามระดับที่จำลอง';
      var pe0 = $("cmpPump"); if (pe0) pe0.style.display = "none";
      return;
    }
    res.className = "prot-result";
    // ทุกมาตรการวัดผลจากโมเดลเดียวกัน: คันกั้นตัดเส้นทางน้ำ (connectivity) · มาตรการระบาย/หน่วง
    // หักปริมาตรที่ดัก/ระบายได้ (mass-balance) ออกจากผืนน้ำท้ายน้ำที่จุดนั้นเชื่อมถึง
    var html = '<i class="ti ti-shield-check"></i> เปิด ' + total + ' มาตรการ · อาคารพ้นน้ำ <b>~' +
      fmt(s.reduced.buildings) + ' หลัง</b> · ลดปริมาตรน้ำท่วม <b>~' + s.reduced.volume_pct + '%</b>' +
      (nLevee > 0
        ? ' <span style="color:#64748b;">(คันกั้นตัดเส้นทางน้ำจากแม่น้ำ — แบบจำลอง connectivity)</span>'
        : ' <span style="color:#64748b;">(หักปริมาตรที่ดัก/ระบายได้ออกจากผืนน้ำท้ายน้ำที่มาตรการเชื่อมถึง — mass-balance screening · ต้องยืนยัน SWMM)</span>');
    // insight: มาตรการกลุ่มระบาย/หน่วงเห็นผลตามระดับน้ำ — เหตุการณ์ใหญ่ต้องมีคันกั้นเป็นหลักร่วม
    if (nLevee === 0) {
      var stgNow = IVCompare.getStage(), rgS = IVCompare.stageRange();
      if (stgNow >= rgS.design - 1.0) {
        html += '<div style="margin-top:7px;padding-top:7px;border-top:1px dashed rgba(0,0,0,.12);font-size:11px;line-height:1.5;color:#334155;">' +
          '<i class="ti ti-bulb" style="color:#b45309;"></i> ที่น้ำใหญ่ระดับนี้ แม่น้ำเทน้ำเข้ามากกว่าที่ระบบระบาย/หน่วงจะเอาออกทัน (เหมือนเหตุการณ์จริง พ.ย. 2568) — ' +
          'มาตรการกลุ่มนี้เห็นผลชัดที่น้ำท่วม<b>ระดับเริ่ม–ปานกลาง</b> (ลองลดสไลเดอร์แม่น้ำ) · เหตุการณ์ออกแบบต้องใช้<b>แนวคันกั้นริมแม่น้ำ</b>เป็นมาตรการหลักร่วมด้วย</div>';
      }
    }
    // Mass-balance ของแก้มลิง (ซื่อตรง): ปริมาตรกักเก็บ เทียบปริมาตรน้ำท่วมที่จำลอง
    var stor = IVCompare.retentionStorage ? IVCompare.retentionStorage() : 0;
    if (stor > 0) {
      var floodVol = s.before.volume_m3;
      var pctTxt = (floodVol > 0) ? ('≈ <b>' + (Math.round(stor / floodVol * 1000) / 10) + '%</b> ของปริมาตรน้ำท่วมที่จำลอง') : '';
      html += '<div style="margin-top:7px;padding-top:7px;border-top:1px dashed rgba(0,0,0,.12);font-size:11px;line-height:1.5;color:#334155;">' +
        '<i class="ti ti-calculator" style="color:#0d9488;"></i> แก้มลิงที่เปิดกักน้ำรวม <b>~' + fmt(stor) + ' ลบ.ม.</b> ' + pctTxt +
        ' <span style="color:#64748b;">· ประเมินแบบสมดุลปริมาตร (mass-balance) — ปริมาตร/อัตราจริงต้องยืนยันด้วย EPA SWMM</span></div>';
    }
    // สรุปคลองระบายน้ำเส้นใหม่ที่เปิด
    if (canalOn && canals.length) {
      var km = canals.reduce(function (a, c) { return a + c.length_m; }, 0) / 1000;
      html += '<div style="margin-top:6px;font-size:11px;line-height:1.5;color:#334155;">' +
        '<i class="ti ti-route" style="color:#0891b2;"></i> คลองระบายน้ำเส้นใหม่ <b>' + canals.length + ' เส้น</b> รวม ~' + km.toFixed(1) +
        ' กม. — ระบายน้ำท้องถิ่นออกสู่แม่น้ำ <span style="color:#64748b;">(ขนาด/ความจุจริงต้อง HEC-RAS/SWMM)</span></div>';
    }
    res.innerHTML = html;
    // หมายเหตุสถานีสูบเมื่อเปิดคันกั้นที่ต้องสูบร่วม
    var pumps = IVCompare.levees().filter(function (l) { return IVCompare.isEnabled(l.rank) && l.needs_pump; });
    var pe = $("cmpPump");
    if (pumps.length) { pe.style.display = "block"; pe.innerHTML = '<i class="ti ti-windmill"></i> คันกั้นที่เปิด ' + pumps.length + ' จุด เป็นแบบล้อมพื้นที่ — ต้องมี<b>สถานีสูบระบายน้ำภายใน</b>ร่วมเสมอ'; }
    else { pe.style.display = "none"; }
  }

  // ============ ผลรายมาตรการ: บรรทัด "มาตรการนี้กัก/ระบาย + ลดน้ำท่วมได้เท่าไร กี่ %" ใต้แต่ละแถวที่เปิด ============
  // ตัวเลขจาก IVCompare.marginalOf = ผลส่วนเพิ่มของมาตรการนี้ เทียบชุดมาตรการที่เปิดอยู่ลบตัวมันออก ณ ระดับน้ำปัจจุบัน
  var impactRows = [], impactTimer = null;
  function attachImpact(el, cb, kind, key, volNote) {
    var box = document.createElement("div");
    box.className = "impact-line";
    var body = el.querySelector("div");            // container ของ .t/.d
    (body || el).appendChild(box);
    impactRows.push({ cb: cb, box: box, kind: kind, key: key, volNote: volNote || "" });
  }
  function updateMeasureImpacts() {
    if (!IVCompare.marginalOf) return;
    var s = IVCompare.stats();
    impactRows.forEach(function (row) {
      if (!row.cb.checked) { row.box.style.display = "none"; return; }
      if (!s || s.before.volume_m3 <= 0) {
        row.box.innerHTML = '<i class="ti ti-droplet-off"></i> ยังไม่มีน้ำท่วมที่ระดับนี้ — กด <b>จำลองน้ำท่วม</b> เพื่อดูผลของมาตรการ';
        row.box.style.display = "block";
        return;
      }
      var m = IVCompare.marginalOf(row.kind, row.key);
      if (!m) { row.box.style.display = "none"; return; }
      var dv = Math.max(0, m.volume_m3), db = Math.max(0, m.buildings);
      var pct = Math.round(dv / s.before.volume_m3 * 1000) / 10;
      row.box.innerHTML = '<i class="ti ti-droplet-down"></i> ' + (row.volNote ? row.volNote + " · " : "") +
        'ช่วยลดน้ำท่วม ~<b>' + fmt(dv) + ' ลบ.ม.</b> = <b>' + pct + '%</b> ของน้ำท่วมทั้งพื้นที่' +
        (db > 0 ? ' · อาคารพ้นน้ำ ~<b>' + fmt(db) + ' หลัง</b>' : '') +
        (dv <= 0 ? ' <span style="color:#64748b;">(ยังไม่เห็นผลเพิ่ม — น้ำระดับนี้มากเกินกว่ามาตรการนี้ หรือมาตรการอื่นที่เปิดอยู่คลุมพื้นที่แล้ว · ลองลดสไลเดอร์แม่น้ำ)</span>' : '');
      row.box.style.display = "block";
    });
  }
  function scheduleImpacts() { clearTimeout(impactTimer); impactTimer = setTimeout(updateMeasureImpacts, 200); }

  // toggle มาตรการเสริม (อัปเกรดสถานีสูบเดิม / ขุดลอกคลองเดิม) — จำลองผ่านความจุระบายของ engine
  function makeExtraToggle(kind, icon, color, title, desc, onChange) {
    var el = document.createElement("label");
    el.className = "struct-tog";
    el.innerHTML = '<input type="checkbox" data-kind="' + kind + '">' +
      '<div><div class="t"><i class="ti ' + icon + '" style="color:' + color + ';"></i> ' + title + '</div>' +
      '<div class="d">' + desc + '</div></div>';
    var cb = el.querySelector("input");
    attachImpact(el, cb, kind === "pumpup" ? "pump" : "dredge", 0);
    decorateRow(el);
    cb.addEventListener("change", function () {
      el.classList.toggle("on", cb.checked);
      if (IVViews.stopPlay) IVViews.stopPlay();
      onChange(cb.checked);

    });
    return el;
  }

  // ================= โครงสร้าง toggles =================
  function buildToggles() {
    var host = $("structToggles"); host.innerHTML = "";
    IVCompare.levees().forEach(function (lv) {
      var el = document.createElement("label");
      el.className = "struct-tog";
      el.innerHTML =
        '<input type="checkbox" data-rank="' + lv.rank + '" data-kind="levee">' +
        '<div><div class="t"><i class="ti ti-shield-half" style="color:#78716c;"></i> ' + lv.label + '</div>' +
        '<div class="d">ป้องกัน ~' + lv.protected + ' หลัง · ~' + (lv.cost_thb / 1e6).toFixed(0) + ' ล้าน฿' +
        (lv.length_m ? ' · ยาว ~' + (lv.length_m / 1000).toFixed(1) + ' กม.' : '') +
        (lv.needs_pump ? ' · ต้องมีประตูระบาย/สูบ' : '') +
        '<br><span style="color:#047857;">วางริมตลิ่งฝั่งเมือง · เลี่ยงรอยอาคาร (ทับ ' + (lv.bld_under_wall || 0) + ' หลัง)</span>' +
        (lv.gates != null ? '<br><span style="color:#6d28d9;"><i class="ti ti-door"></i> ต้องมีประตูระบาย/สูบ ' + lv.gates + ' จุด (ตัดถนน)</span>' : '') +
        (lv.newly_flooded != null ? '<br><span style="color:#b45309;"><i class="ti ti-scale"></i> No-Adverse-Impact: อาคารกระทบเพิ่ม ' + lv.newly_flooded + ' — ต้องยืนยัน HEC-RAS 2D</span>' : '') +
        '</div></div>';
      var cb = el.querySelector("input");
      attachImpact(el, cb, "levee", lv.rank);
      decorateRow(el);
      cb.addEventListener("change", function () {
        el.classList.toggle("on", cb.checked);
        IVCompare.toggle(lv.rank, cb.checked);
        if (window.toggleLayerVisibility) {
          window.toggleLayerVisibility('levee', cb.checked);
        }

        if (view === "2d" && lmap) lmap.panInsideBounds && fitToActive();
      });
      host.appendChild(el);
    });
    // มาตรการเสริมที่ใช้โครงสร้างเดิมของเทศบาล — จำลองผลได้ทันที ไม่ต้องจัดหาที่ดิน
    var pumpN = IVCompare.pumpCount ? IVCompare.pumpCount() : 0;
    if (pumpN > 0) host.appendChild(makeExtraToggle(
      "pumpup", "ti-windmill", "#0284c7",
      "เพิ่มกำลังสถานีสูบน้ำเดิม (" + pumpN + " สถานี)",
      "อัปเกรดเครื่องสูบ + เครื่องสำรอง/ไฟสำรอง ที่สถานีสูบของเทศบาลที่มีอยู่แล้ว · เห็นผลรอบย่านรับน้ำของสถานี (รัศมีบริการ ~240 ม.) · ไม่ต้องเวนคืนที่ดิน (screening · อัตราสูบจริงต้อง SWMM)",
      function (on) { if (IVCompare.togglePumpUpgrade) IVCompare.togglePumpUpgrade(on); }));
    var dkm = IVCompare.dredgeKm ? IVCompare.dredgeKm() : 0;
    if (dkm > 0) host.appendChild(makeExtraToggle(
      "dredge", "ti-backhoe", "#b45309",
      "ขุดลอกคลอง/คูระบายน้ำเดิม (โครงข่าย ~" + Math.round(dkm) + " กม.)",
      "เพิ่มความจุคลองระบายที่มีอยู่ทั้งโครงข่าย — ทำได้เร็ว งบต่ำ · น้ำตามแนวคลองและพื้นที่ข้างเคียงตื้นลง (screening · หน้าตัด/ความจุจริงต้อง HEC-RAS/SWMM)",
      function (on) { if (IVCompare.toggleDredge) IVCompare.toggleDredge(on); }));
  }
  function fitToActive() { /* คงมุมมองเดิม — ไม่บังคับซูม */ }

  // โฟกัสไปจุดหนึ่ง (3D บินไป / 2D pan) — ใช้กับรายการมาตรการเชิงข้อมูล
  function focusPoint(lng, lat) {
    if (view === "3d" && IV3D.flyTo) IV3D.flyTo(lng, lat);
    else if (lmap) lmap.flyTo([lat, lng], 15, { animate: true });
  }

  // ============ มาตรการกายภาพ (แก้มลิง/คอขวด/ประตู) — จำลองผลลดน้ำท่วมรายจุด (screening) ============
  function buildInfoMeasures() {
    var host = $("structToggles");
    fetch("data/intervention_candidates.geojson?t=" + Date.now()).then(function (r) { return r.json(); }).then(function (fc) {
      var pts = (fc.features || []).filter(function (f) {
        return f.geometry && f.geometry.type === "Point" && (f.properties.kind === "bottleneck" || f.properties.kind === "retention" || f.properties.kind === "floodgate");
      });
      if (!pts.length) return;
      var wrap = document.createElement("div");
      wrap.innerHTML = '<div class="info-divider"><i class="ti ti-flask"></i> มาตรการกายภาพแนะนำ (บ่อหน่วง/ขยายท่อ/ประตูระบาย) — ติ๊กเพื่อจำลองผลลดน้ำท่วม (screening · ปริมาตรจริงต้อง SWMM)</div>';
      // แก้มลิงก่อน แล้วคอขวด แล้วประตูระบาย
      pts.sort(function (a, b) {
        var ka = a.properties.kind, kb = b.properties.kind;
        var oa = ka === "retention" ? 1 : (ka === "bottleneck" ? 2 : 3);
        var ob = kb === "retention" ? 1 : (kb === "bottleneck" ? 2 : 3);
        return oa - ob;
      });
      pts.forEach(function (f) {
        var p = f.properties, kind = p.kind;
        var lng = f.geometry.coordinates[0], lat = f.geometry.coordinates[1];
        var icon, col;
        if (kind === "retention") { icon = "ti-droplet"; col = "#0d9488"; }
        else if (kind === "bottleneck") { icon = "ti-windmill"; col = "#ea580c"; }
        else { icon = "ti-door"; col = "#7c3aed"; }

        var detail;
        if (kind === "retention") {
          var land = (p.buildings_on_site === 0 && (p.road_on_site || 0) === 0) ? " · ที่ว่าง ไม่ทับอาคาร/ถนน"
            : (p.buildings_on_site === 0 ? " · เลี่ยงอาคารแล้ว" + ((p.road_on_site || 0) > 0 ? " (มีถนนพาด)" : "")
            : (p.buildings_on_site != null ? " · มีอาคาร ~" + p.buildings_on_site + " หลัง" : ""));
          detail = "บ่อหน่วง ~" + (p.area_rai || "?") + " ไร่ · เก็บ ~" + ((p.storage_m3 || 0).toLocaleString()) + " ลบ.ม." + land;
        } else if (kind === "bottleneck") {
          var spot = p.relocated ? " · ขยับเลี่ยงอาคารแล้ว" : (p.on_road ? " · ตั้งริมถนนได้" : "");
          detail = "ความจุระบายปัจจุบัน " + (p.drain_cm != null ? p.drain_cm + " ซม." : "ต่ำ") + " · ควรเพิ่มท่อ/สูบ" + spot;
        } else {
          detail = "ติดตั้งตรงจุดน้ำล้นริมคลอง/แม่น้ำหลัก เพื่อบล็อกน้ำไหลย้อนเข้าท่อ";
        }

        var el = document.createElement("label");
        el.className = "struct-tog";
        el.innerHTML =
          '<input type="checkbox">' +
          '<div><div class="t"><i class="ti ' + icon + '" style="color:' + col + ';"></i> ' + p.label + '</div>' +
          '<div class="d">' + esc(detail) + '</div></div>';
        
        // เซลล์ศูนย์กลางของมาตรการ (คำนวณสูตรเดียวกับ engine → key ตรงกัน)
        var mc = Math.floor((lng - meta.OLON) / meta.DLON), mr = Math.floor((meta.OLAT - lat) / meta.DLAT);
        var cell = mr * NC + mc;
        var cb = el.querySelector("input");
        cb.dataset.kind = kind;
        // บรรทัดผลรายมาตรการ: แก้มลิงโชว์ความจุบ่อ (mass-balance) · คอขวดโชว์ปริมาตรที่สูบ/ระบายเพิ่ม (screening)
        if (kind === "retention") attachImpact(el, cb, "ret", cell, 'กักน้ำเข้าบ่อ ~<b>' + fmt(p.storage_m3 || 7200) + ' ลบ.ม.</b>');
        else if (kind === "bottleneck") attachImpact(el, cb, "btl", cell, 'สูบ/ระบายเพิ่ม ~<b>12,000 ลบ.ม.</b>');
        else attachImpact(el, cb, "gate", cell);
        decorateRow(el);
        cb.addEventListener("change", function () {
          el.classList.toggle("on", cb.checked);
          if (IVViews.stopPlay) IVViews.stopPlay();
          // สั่ง engine จำลองผลของมาตรการนี้จริง (ก่อนหน้านี้ checkbox ไม่เชื่อมกับ engine → บ่อไม่มีผล)
          if (kind === "retention") IVCompare.toggleRetention(cell, cb.checked);
          else if (kind === "bottleneck") IVCompare.toggleBottleneck(cell, cb.checked);
          else if (kind === "floodgate") IVCompare.toggleFloodgate(cell, cb.checked);
          if (window.toggleLayerVisibility) window.toggleLayerVisibility(kind, cb.checked);
          if (cb.checked) focusPoint(lng, lat);
        });
        wrap.appendChild(el);
      });
      host.appendChild(wrap);
    }).catch(function (e) { console.warn("info measures โหลดไม่ได้", e); });
  }

  // ================= คลองระบายน้ำเส้นใหม่ (แนวขุดจากแอ่งแก้มลิง → แม่น้ำ) =================
  function buildCanals() {
    var routes = IVCompare.canals ? IVCompare.canals() : [];
    if (!routes.length) return;
    canalLayer = L.layerGroup();
    var totalKm = 0;
    routes.forEach(function (rt, i) {
      totalKm += rt.length_m / 1000;
      var latlng = rt.line.map(function (p) { return [p[1], p[0]]; });
      var popup = '<b>คลองระบายน้ำเส้นใหม่ ' + (i + 1) + '</b><br>ความยาว ~' + rt.length_m.toLocaleString() +
        ' ม. · ระบายน้ำจากแอ่งแก้มลิงออกสู่แม่น้ำปัตตานี<br>' +
        '<span style="color:#b45309;">แนว least-cost (เลี่ยงขึ้นเนิน/อาคาร) — ขนาด/ความลาด/ความจุ ต้องออกแบบด้วย HEC-RAS/SWMM</span>';
      L.polyline(latlng, { color: "#ffffff", weight: 7, opacity: 0.9, lineCap: "round", lineJoin: "round" }).addTo(canalLayer);      // casing ขาว
      L.polyline(latlng, { color: "#0891b2", weight: 3.5, opacity: 0.95, lineCap: "round", lineJoin: "round" }).bindPopup(popup).addTo(canalLayer);  // ตัวคลอง
    });
    // toggle ในแผงมาตรการ
    var host = $("structToggles");
    var el = document.createElement("label");
    el.className = "struct-tog";
    el.innerHTML =
      '<input type="checkbox">' +
      '<div><div class="t"><i class="ti ti-route" style="color:#0891b2;"></i> คลองระบายน้ำเส้นใหม่ (' + routes.length + ' เส้น)</div>' +
      '<div class="d">แนวขุดคลองจากแอ่งแก้มลิง → แม่น้ำปัตตานี · least-cost เลี่ยงอาคาร · รวม ~' + totalKm.toFixed(1) + ' กม.' +
      '<br><span style="color:#b45309;">ระบายน้ำฝนสะสม/น้ำท้องถิ่นออกจากเมือง — ขนาด/ความจุจริงต้อง HEC-RAS/SWMM</span></div></div>';
    var cb = el.querySelector("input");
    cb.dataset.kind = "canal";
    var canalCap = routes.reduce(function (a, rt) { return a + rt.length_m * 6; }, 0);   // หน้าตัด ~6 ตร.ม./ม. (screening)
    attachImpact(el, cb, "canal", 0, 'พาน้ำออก ~<b>' + fmt(canalCap) + ' ลบ.ม.</b>');
    decorateRow(el);
    cb.addEventListener("change", function () {
      el.classList.toggle("on", cb.checked);
      canalOn = cb.checked;
      if (IVViews.stopPlay) IVViews.stopPlay();
      if (cb.checked) { if (lmap && !lmap.hasLayer(canalLayer)) canalLayer.addTo(lmap); }
      else if (lmap) canalLayer.removeFrom(lmap);
      if (IV3D.toggleCanal) IV3D.toggleCanal(cb.checked);
      if (IVCompare.toggleCanalDrain) IVCompare.toggleCanalDrain(cb.checked);   // คลองมีผลระบายจริงตามแนว
      updateStats();                                     // นับรวมคลองในสรุปมาตรการ
      if (cb.checked && routes[0]) focusPoint(routes[0].from.lng, routes[0].from.lat);
    });
    host.appendChild(el);
  }

  // ================= mount =================
  function mount(leaflet_map, Lref) {
    L = Lref; lmap = leaflet_map; meta = IVCompare.meta(); NC = meta.NC; NR = meta.NR;
    $("sStage") && ($("sStage").textContent = meta.DESIGN_S);

    canvas = document.createElement("canvas"); canvas.width = NC; canvas.height = NR;
    ctx = canvas.getContext("2d");
    // custom pane z-index 450 เพื่อให้ flood canvas อยู่เหนือ vector layers (z-index 400) เสมอ
    lmap.createPane("floodPane"); lmap.getPane("floodPane").style.zIndex = 450;
    floodOverlay = L.imageOverlay("", IVCompare.boundsLatLng(),
      { opacity: 0.8, interactive: false, className: "iv-flood", pane: "floodPane" }).addTo(lmap);

    buildToggles();
    buildInfoMeasures();
    buildCanals();
    updateStats();
    draw2D();

    // controls — โชว์สถานะ "มีโครงสร้าง" เสมอ (เอา UI เปรียบเทียบ ก่อน/หลัง ออก แต่เก็บโค้ดไว้)
    IVCompare.setSplit(0);
    $("vw2d").addEventListener("click", function () { switchView("2d"); });
    $("vw3d").addEventListener("click", function () { switchView("3d"); });

    // ---- ระดับน้ำ (ฝน/แม่น้ำ/เขื่อน) ----
    function applyLevel() {
      var rain = +$("sRain").value, river = +$("sRiver").value, dam = +$("sDam").value;
      $("vRain").textContent = rain; $("vRiver").textContent = river; $("vDam").textContent = dam;
      IVCompare.setStage(IVCompare.stageFromInputs(rain, river, dam));
      try { localStorage.setItem("yalaSim", JSON.stringify({ rain: rain, river: river, dam: dam })); } catch (e) {}   // แชร์ระดับน้ำกับหน้าจำลอง
    }
    applyLevelFn = applyLevel;
    function updateLevelReadout() {
      var s = IVCompare.getStage(), rg = IVCompare.stageRange(), tag = $("lvlTag");
      $("lvlStage").textContent = s.toFixed(2);
      if (s >= rg.design - 0.05) { tag.textContent = "เหตุการณ์ออกแบบ"; tag.className = "lvl-tag design"; }
      else if (s >= rg.onset) { tag.textContent = "เริ่มท่วม"; tag.className = "lvl-tag onset"; }
      else { tag.textContent = "ปกติ"; tag.className = "lvl-tag calm"; }
    }

    IVCompare.subscribe(function (kind) {
      if (view === "2d") draw2D();
      if (mount3dFn && IV3D.onUpdate) IV3D.onUpdate(kind);
      if (kind === "after") { updateStats(); scheduleImpacts(); }
      if (kind === "stage") { updateStats(); updateLevelReadout(); scheduleImpacts(); }
    });

    // ---- อนิเมชัน "จำลองการท่วม": ไล่ระดับน้ำจากแห้ง → เป้าหมาย (น้ำแพร่ตามลำดับการท่วม) ----
    var playTimer = null;
    function stopPlay() {
      if (playTimer) { clearInterval(playTimer); playTimer = null; }
      var btn = $("btnPlayFlood");
      if (btn) { btn.classList.remove("playing"); btn.innerHTML = '<i class="ti ti-droplet-filled-2"></i> จำลองน้ำท่วม'; }
      var tlBtn = $("tlPlay"), tlIco = tlBtn ? tlBtn.querySelector("i") : null, tlTxt = $("tlPlayTxt");
      if (tlBtn) tlBtn.classList.remove("playing");
      if (tlIco) tlIco.className = "ti ti-player-play";
      if (tlTxt) tlTxt.textContent = "เล่นจำลองน้ำท่วม";
    }
    IVViews.stopPlay = stopPlay;   // expose เพื่อให้ chkLevee handler หยุด animation ก่อนเปลี่ยนระดับน้ำ
    function playFlood() {
      if (playTimer) { stopPlay(); return; }
      var rng = IVCompare.stageRange();
      var base = rng.min, target = IVCompare.stageFromInputs(+$("sRain").value, +$("sRiver").value, +$("sDam").value);
      var tlSld = $("tlSld"), tlPct = $("tlPct");
      var steps = 100, step = tlSld ? +tlSld.value : 0;
      if (step >= steps) step = 0;
      
      var btn = $("btnPlayFlood");
      if (btn) { btn.classList.add("playing"); btn.innerHTML = '<i class="ti ti-square-filled"></i> หยุด'; }
      var tlBtn = $("tlPlay"), tlIco = tlBtn ? tlBtn.querySelector("i") : null, tlTxt = $("tlPlayTxt");
      if (tlBtn) tlBtn.classList.add("playing");
      if (tlIco) tlIco.className = "ti ti-player-pause";
      if (tlTxt) tlTxt.textContent = "หยุด";
      
      if (step === 0) IVCompare.setStage(base);
      playTimer = setInterval(function () {
        step += 2; // Move 2% per tick (50 ticks * 100ms = 5s total)
        if (step > steps) step = steps;
        IVCompare.setStage(base + (target - base) * (step / steps));
        if (tlSld) tlSld.value = step;
        if (tlPct) tlPct.textContent = step + "%";
        if (step >= steps) stopPlay();
      }, 100);
    }

    ["sRain", "sRiver", "sDam"].forEach(function (id) { $(id).addEventListener("input", function () { stopPlay(); applyLevel(); }); });
    $("btnDesignEvent").addEventListener("click", function () { stopPlay(); $("sRain").value = 40; $("sRiver").value = 700; $("sDam").value = 300; applyLevel(); });
    $("btnPlayFlood").addEventListener("click", playFlood);
    
    var tlSld = $("tlSld"), tlPlay = $("tlPlay"), bReset2 = $("bReset2"), tlPct = $("tlPct");
    if (tlPlay) tlPlay.addEventListener("click", playFlood);
    if (tlSld) tlSld.addEventListener("input", function() {
      stopPlay();
      var rng = IVCompare.stageRange();
      var base = rng.min, target = IVCompare.stageFromInputs(+$("sRain").value, +$("sRiver").value, +$("sDam").value);
      var step = +this.value;
      IVCompare.setStage(base + (target - base) * (step / 100));
      if (tlPct) tlPct.textContent = step + "%";
    });
    if (bReset2) bReset2.addEventListener("click", function() {
      stopPlay();
      if (tlSld) tlSld.value = 0;
      if (tlPct) tlPct.textContent = "0%";
      IVCompare.setStage(IVCompare.stageRange().min);
    });
    $("togFlow").addEventListener("change", function () { if (IV3D.setFlow) IV3D.setFlow(this.checked); });

    // ---- ดึงค่าจริง (เขื่อน/ฝน) เหมือนหน้า 3D ----
    var bLive = $("btnLive"), liveStatus = $("liveStatus");
    if (bLive) bLive.addEventListener("click", function () {
      bLive.disabled = true; bLive.innerHTML = '<i class="ti ti-loader"></i> กำลังดึง...';
      Promise.resolve(window.YalaLive ? YalaLive.fetchLive() : { data: null }).then(function (rep) {
        var dam = rep && rep.data ? rep.data.released : null, rain = rep && rep.data ? rep.data.rainfall : null;   // อัตราระบายจริง (m³/s)
        if (dam != null) $("sDam").value = Math.min(400, Math.max(0, Math.round(dam)));
        if (rain != null) $("sRain").value = Math.min(500, Math.max(0, Math.round(rain)));
        stopPlay(); applyLevel();
        liveStatus.innerHTML = (dam != null || rain != null)
          ? 'ค่าจริง · เขื่อนระบาย ' + (dam != null ? dam.toFixed(0) + ' m³/s' : '–') + ' · ฝน ' + (rain != null ? rain.toFixed(1) + ' mm/hr' : '–') + ' → กด "จำลองการท่วม"'
          : 'ดึงค่าจริงไม่ได้ — ปรับสไลเดอร์เองได้';
      }).catch(function () { liveStatus.textContent = 'ดึงค่าจริงไม่ได้ — ปรับสไลเดอร์เองได้'; })
        .then(function () { bLive.disabled = false; bLive.innerHTML = '<i class="ti ti-rss"></i> ดึงค่าปัจจุบันจริง'; });
    });

    // ดึงระดับน้ำที่ "จำลองไว้ในหน้าจำลองน้ำท่วม" (yalaSim) มาตั้งเป็นค่าเริ่มต้น
    (function restoreFromSim() {
      var s = null; try { s = JSON.parse(localStorage.getItem("yalaSim") || "null"); } catch (e) {}
      if (!s) return;
      if (s.rain != null) { $("sRain").value = s.rain; $("vRain").textContent = s.rain; }
      if (s.river != null) { $("sRiver").value = s.river; $("vRiver").textContent = s.river; }
      if (s.dam != null) { $("sDam").value = s.dam; $("vDam").textContent = s.dam; }
      var note = $("simNote"); if (note) note.style.display = "flex";
    })();
    // เริ่มด้วยสภาวะแห้ง (ไม่โหลดค่าน้ำท่วมจาก localStorage) — ผู้ใช้กด "จำลองน้ำท่วม" เพื่อเริ่ม
    IVCompare.setStage(IVCompare.stageRange().min);
    updateLevelReadout();
    // มุมมองเริ่มต้นตาม ?v= (มาจากปุ่มหน้าต่างบนแถบนำทาง) — ค่าเริ่มต้น 3D
    var v0 = (new URLSearchParams(location.search).get("v") === "2d") ? "2d" : "3d";
    if (v0 === "3d") switchView("3d");
    else { $("vw2d").classList.add("active"); $("vw3d").classList.remove("active"); syncNav("2d"); }
  }

  // มุมมอง 2D/3D เลือกบนแผนที่ → จำไว้ใน yalaView + อัปเดตลิงก์หน้าต่างให้เปิดมุมมองเดิม
  function syncNav(v) {
    try { localStorage.setItem("yalaView", v); } catch (e) {}
    var nf = document.getElementById("navFlood"); if (nf) nf.href = (v === "2d" ? "dashboard.html" : "index.html");
    var ni = document.getElementById("navIv"); if (ni) ni.href = "interventions.html?v=" + v;
  }

  // นำสถานะ toggle (checkbox ที่ติ๊กไว้) ไปใช้กับเลเยอร์ 3D — กันกรณีติ๊กใน 2D ก่อน 3D จะ mount
  function sync3DLayers() {
    var boxes = document.querySelectorAll("#structToggles input[type=checkbox]");
    Array.prototype.forEach.call(boxes, function (cb) {
      if (!cb.checked) return;
      var kind = cb.dataset.kind;
      if (kind === "canal") { if (IV3D.toggleCanal) IV3D.toggleCanal(true); }
      else if (kind && IV3D.toggleKind) { IV3D.toggleKind(kind, true); }
    });
  }

  // ================= สลับมุมมอง 2D/3D =================
  var fellBack3d = false;
  function switchView(v) {
    if (v === view) return; view = v;
    $("vw2d").classList.toggle("active", v === "2d");
    $("vw3d").classList.toggle("active", v === "3d");
    syncNav(v);
    var d3 = $("map3d"), m2 = $("map");
    if (v === "3d") {
      d3.style.display = "block";
      if (m2) m2.style.visibility = "hidden";       // กัน Leaflet โผล่ทะลุ canvas 3D
      if (!mount3dFn) { mount3dFn = true; IV3D.mount(d3, meta, on3dUnavailable, sync3DLayers); }
      else { IV3D.show && IV3D.show(); sync3DLayers(); }
    } else {
      d3.style.display = "none";
      if (m2) m2.style.visibility = "visible";
      IV3D.hide && IV3D.hide();
      draw2D();
    }
  }
  // ถ้า 3D เรนเดอร์ไม่ได้ (ไม่มี WebGL2) → กลับมา 2D อัตโนมัติ
  function on3dUnavailable() {
    if (fellBack3d) return; fellBack3d = true;
    if (view === "3d") switchView("2d");
    var ls = $("liveStatus"); if (ls) { /* no-op */ }
    var b = $("vw3d"); if (b) b.title = "มุมมอง 3D ต้องใช้ WebGL2 (เบราว์เซอร์นี้ไม่รองรับ) — กำลังแสดง 2D";
  }

  return { mount: mount, redraw2D: draw2D, getView: function () { return view; } };
})();

// IV3D ถูกนิยามใน intervention_3d.js (Stage 3) — กันพังถ้ายังไม่โหลด
window.IV3D = window.IV3D || { mount: function (el, _meta, onFail) { if (onFail) setTimeout(onFail, 50); }, onUpdate: function () {}, setFlow: function () {}, flyTo: function () {}, show: function () {}, hide: function () {}, toggleCanal: function () {}, toggleKind: function () {} };
