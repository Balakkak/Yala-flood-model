/* Leaflet smooth wheel zoom — ซูมล้อเมาส์/แทร็คแพดแบบต่อเนื่อง (fractional zoom + easing ต่อเฟรม)
 * ให้ความรู้สึกไหลลื่นแบบ MapLibre GL แทนการกระโดดทีละระดับของ Leaflet ปกติ
 * ใช้กับแผนที่ที่สร้างด้วย: { scrollWheelZoom:false, smoothWheelZoom:true, zoomSnap:0 }
 */
(function () {
  if (!window.L) return;

  L.Map.SmoothWheelZoom = L.Handler.extend({
    addHooks: function () {
      L.DomEvent.on(this._map._container, "wheel", this._onWheel, this);
    },
    removeHooks: function () {
      L.DomEvent.off(this._map._container, "wheel", this._onWheel, this);
    },

    _onWheel: function (e) {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
      var map = this._map;
      var delta = e.deltaY * (e.deltaMode === 1 ? 20 : 1); // deltaMode 1 = หน่วยบรรทัด (Firefox)
      // pinch บนแทร็คแพดมาเป็น wheel+ctrlKey ค่า delta เล็ก — ต้องคูณแรงกว่า scroll ปกติ
      var sens = (map.options.smoothWheelSensitivity || 1) * (e.ctrlKey ? 0.01 : 0.0032);

      if (!this._active) {
        this._active = true;
        this._goal = map.getZoom();
        L.Util.requestAnimFrame(this._step, this);
      }
      this._around = map.mouseEventToLatLng(e); // ซูมเข้าหาจุดใต้เมาส์เสมอ
      this._goal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), this._goal - delta * sens));
      this._lastWheel = performance.now();
    },

    _step: function () {
      var map = this._map, z = map.getZoom(), dz = this._goal - z;
      if (Math.abs(dz) > 0.004) {
        map.setZoomAround(this._around, z + dz * 0.3, { animate: false });
        L.Util.requestAnimFrame(this._step, this);
      } else if (performance.now() - this._lastWheel < 200) {
        L.Util.requestAnimFrame(this._step, this); // gesture ยังไม่จบ รอ wheel เฟรมถัดไป
      } else {
        if (Math.abs(dz) > 0) map.setZoomAround(this._around, this._goal, { animate: false });
        this._active = false;
      }
    }
  });

  L.Map.addInitHook("addHandler", "smoothWheelZoom", L.Map.SmoothWheelZoom);
})();
