/* ============================================================================
 * nav.js — แถบนำทาง 2 หน้าต่าง (จำลองน้ำท่วม / แก้โครงสร้าง)
 * ----------------------------------------------------------------------------
 * header แสดงแค่ชื่อหน้าต่าง · การเลือก 2D/3D อยู่บนแผนที่ที่เดียว
 * จำมุมมองที่เลือกไว้ใน localStorage["yalaView"] เพื่อให้ปุ่มหน้าต่างเปิดมุมมองเดิม
 * ========================================================================== */
(function () {
  "use strict";
  var page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  var isFlood = (page === "index.html" || page === "dashboard.html" || page === "");
  var isIv = (page === "interventions.html");

  var view;
  try { view = localStorage.getItem("yalaView"); } catch (e) {}
  if (page === "dashboard.html") view = "2d";                 // หน้านี้คือมุมมอง 2D ของจำลอง
  else if (page === "index.html" || page === "") view = "3d"; // หน้านี้คือมุมมอง 3D ของจำลอง
  else {                                                       // interventions: จาก ?v หรือค่าที่จำไว้
    var v = new URLSearchParams(location.search).get("v");
    if (v === "2d" || v === "3d") view = v;
    if (view !== "2d" && view !== "3d") view = "3d";
  }
  try { localStorage.setItem("yalaView", view); } catch (e) {}

  var nf = document.getElementById("navFlood"), ni = document.getElementById("navIv");
  if (nf) { nf.href = (view === "2d" ? "dashboard.html" : "index.html"); if (isFlood) nf.classList.add("active"); }
  if (ni) { ni.href = "interventions.html?v=" + view; if (isIv) ni.classList.add("active"); }

  // ปุ่ม 2D/3D บนแผนที่ (หน้าจำลอง): จำมุมมองก่อนไปหน้าปลายทาง
  var tgs = document.querySelectorAll(".map-view-toggle a[data-v]");
  for (var i = 0; i < tgs.length; i++) {
    (function (a) {
      a.addEventListener("click", function () {
        try { localStorage.setItem("yalaView", a.getAttribute("data-v")); } catch (e) {}
      });
    })(tgs[i]);
  }
})();
