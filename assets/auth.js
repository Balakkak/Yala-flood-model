/* ============================================================================
 * auth.js — ด่านล็อกอินฝั่ง client (demo gate)
 * ----------------------------------------------------------------------------
 * ⚠ ไม่ใช่ระบบความปลอดภัยจริง — เว็บนี้เป็น static ไม่มี backend
 *   ใครปิด JS / เปิด devtools ก็ผ่านได้ ใช้เพื่อ "กันคนทั่วไป" ในงานเดโมเท่านั้น
 *   (ไม่ได้ป้องกันข้อมูลที่อ่อนไหว — ข้อมูลทั้งหมดเป็นข้อมูลเปิด)
 *
 * วางเป็น <script> ตัวแรกใน <head> ของหน้าที่ต้องล็อกอิน
 *   - ถ้ายังไม่ล็อกอิน → เด้งไป login.html
 *   - ข้ามการตรวจถ้าถูกฝังใน iframe (หน้าแม่ตรวจให้แล้ว เช่น city3d ใน dashboard)
 * ========================================================================== */
(function () {
  try {
    if (window.top !== window.self) return;               // embedded → parent guards
    if (sessionStorage.getItem("yala_auth") === "1") { wireLogout(); return; }
  } catch (e) { /* sandboxed iframe ฯลฯ */ return; }
  location.replace("login.html");

  function wireLogout() {
    function bind() {
      var btn = document.getElementById("logoutBtn");
      if (!btn) return;
      btn.addEventListener("click", function () {
        try { sessionStorage.removeItem("yala_auth"); } catch (e) {}
        location.replace("login.html");
      });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
    else bind();
  }
})();
