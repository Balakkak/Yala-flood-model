#!/bin/bash
# เริ่ม dev server ของแดชบอร์ด GIS น้ำท่วมยะลา
# รันจากที่ไหนก็ได้ — สคริปต์จะ cd ไปรากโปรเจกต์ให้เอง

cd "$(dirname "$0")/.." || exit 1

echo "🚀 เริ่ม Dev Server (Vite)..."
echo ""
echo "📍 เปิด browser ที่: http://localhost:5173/   (index.html)"
echo ""
echo "กด Ctrl+C เพื่อหยุด server"
echo ""

npm run dev
