/* Leaflet smooth wheel zoom — ซูมล้อเมาส์/แทร็คแพดแบบต่อเนื่อง (fractional zoom + easing ต่อเฟรม)
 * ให้ความรู้สึกไหลลื่นแบบ MapLibre GL แทนการกระโดดทีละระดับของ Leaflet ปกติ
 * ใช้กับแผนที่ที่สร้างด้วย: { scrollWheelZoom:false, smoothWheelZoom:true, zoomSnap:0 }
 *
 * สำคัญ: ระหว่างท่าซูมต้องเดินเส้นทางเดียวกับ pinch-zoom ของ Leaflet
 * (_moveStart → _move({pinch:true}) ต่อเฟรม → _moveEnd ครั้งเดียวตอนจบ)
 * เพื่อให้กระเบื้องแผนที่ถูกสเกลด้วย CSS เฉย ๆ แล้วค่อยโหลดชุดใหม่ตอนนิ่ง —
 * ถ้าใช้ setZoomAround ต่อเฟรม tile layer จะ reset/โหลด/เฟดใหม่ทุกเฟรม → จอกระพริบ
 */
(function () {
  if (!window.L) return;

  L.Map.SmoothWheelZoom = L.Handler.extend({
    addHooks: function () {
      L.DomEvent.on(this._map._container, "wheel", this._onWheel, this);
    },
    removeHooks: function () {
      L.DomEvent.off(this._map._container, "wheel", this._onWheel, this);
      this._end();
    },

    _onWheel: function (e) {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
      var map = this._map;
      var delta = e.deltaY * (e.deltaMode === 1 ? 20 : 1); // deltaMode 1 = หน่วยบรรทัด (Firefox)
      // pinch บนแทร็คแพดมาเป็น wheel+ctrlKey ค่า delta เล็ก — ต้องคูณแรงกว่า scroll ปกติ
      var sens = (map.options.smoothWheelSensitivity || 1) * (e.ctrlKey ? 0.01 : 0.0032);

      if (!this._active) {
        map._stop(); // หยุด flyTo/pan animation ค้าง ๆ ก่อนเริ่มท่าซูม
        this._active = true;
        this._moved = false;
        this._goal = map.getZoom();
        this._mousePos = map.mouseEventToContainerPoint(e);
        this._around = map.containerPointToLatLng(this._mousePos); // จุดยึดใต้เมาส์ตอนเริ่มท่า
        this._frame = L.Util.requestAnimFrame(this._step, this);
      } else {
        this._mousePos = map.mouseEventToContainerPoint(e);
      }
      this._goal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), this._goal - delta * sens));
      this._lastWheel = performance.now();
      clearTimeout(this._endTimer);
      this._endTimer = setTimeout(L.Util.bind(this._end, this), 260); // กันเฟรมหยุดเดิน (แท็บพื้นหลัง)
    },

    // center ที่ทำให้ latlng จุดยึดคงอยู่ใต้เมาส์พอดี ณ ซูมที่กำหนด
    _centerFor: function (zoom) {
      var map = this._map;
      return map.unproject(
        map.project(this._around, zoom).subtract(this._mousePos).add(map.getSize().divideBy(2)), zoom);
    },

    _step: function () {
      if (!this._active) return;
      var map = this._map, z = map.getZoom(), dz = this._goal - z;
      if (Math.abs(dz) > 0.003) {
        var zoom = z + dz * 0.3;
        if (!this._moved) { map._moveStart(true, false); this._moved = true; }
        map._move(this._centerFor(zoom), zoom, { pinch: true, round: false });
        this._frame = L.Util.requestAnimFrame(this._step, this);
      } else if (performance.now() - this._lastWheel < 200) {
        this._frame = L.Util.requestAnimFrame(this._step, this); // ท่ายังไม่จบ รอ wheel ถัดไป
      } else {
        this._end();
      }
    },

    _end: function () {
      if (!this._active) return;
      this._active = false;
      clearTimeout(this._endTimer);
      L.Util.cancelAnimFrame(this._frame);
      if (!this._moved) return;
      var map = this._map;
      map._move(this._centerFor(this._goal), this._goal, { pinch: true, round: false });
      map._moveEnd(true); // จบท่าครั้งเดียว → tile layer โหลด/จัดกระเบื้องชุดใหม่ตรงนี้ทีเดียว
    }
  });

  L.Map.addInitHook("addHandler", "smoothWheelZoom", L.Map.SmoothWheelZoom);
})();
