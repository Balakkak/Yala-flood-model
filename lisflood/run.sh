#!/bin/bash
# ============================================================================
# run.sh — pipeline LISFLOOD-FP ครบวงจรสำหรับยะลา (macOS Apple Silicon)
#   build (ครั้งเดียว) -> สร้าง input จาก DEM -> รันจำลอง -> แปลงเป็นเฟรม PNG
# ใช้: bash lisflood/run.sh
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/src"
INPUTS="$HERE/inputs"
LIBOMP="$(brew --prefix libomp)"
export DYLD_LIBRARY_PATH="${LIBOMP}/lib:${DYLD_LIBRARY_PATH:-}"

# 1) build (ข้ามถ้ามี binary แล้ว) -------------------------------------------
if [ ! -x "$SRC/build/lisflood" ]; then
  echo "▶ building LISFLOOD-FP (native arm64)…"
  rm -rf "$SRC/build"
  OMP_HINTS=(-Xpreprocessor -fopenmp -I"${LIBOMP}/include")
  cmake -B "$SRC/build" -S "$SRC" \
    -D_CONFIG="$SRC/config_macos.cmake" -DCMAKE_BUILD_TYPE=Release \
    -DOpenMP_CXX_FLAGS="${OMP_HINTS[*]}" -DOpenMP_CXX_LIB_NAMES=omp \
    -DOpenMP_C_FLAGS="${OMP_HINTS[*]}"   -DOpenMP_C_LIB_NAMES=omp \
    -DOpenMP_omp_LIBRARY="${LIBOMP}/lib/libomp.dylib"
  cmake --build "$SRC/build" --target lisflood -j
fi

# 2) สร้าง input จาก DEM จริง ------------------------------------------------
echo "▶ generating inputs from DEM…"
python3 "$INPUTS/make_inputs.py"

# 3) รันจำลอง ---------------------------------------------------------------
echo "▶ running simulation…"
cd "$INPUTS"
mkdir -p results
"$SRC/build/lisflood" -v yala.par

# 4) แปลงผล -> เฟรม PNG + manifest ------------------------------------------
echo "▶ post-processing depth grids…"
python3 "$HERE/postprocess/wd_to_frames.py"     # เฟรม PNG (ชั้นน้ำ 2D + flat drape)
python3 "$HERE/postprocess/wd_to_water3d.py"    # กริดน้ำ 3D (หน้า city3d)

echo "✅ เสร็จ — เปิดแดชบอร์ด: ชั้น 'ผลจำลอง LISFLOOD-FP 2D' + ปุ่ม 'โมเดล 3D เมือง'"
