# Tesla Active Sound

**เสียงเครื่องยนต์จำลองสำหรับรถ Tesla — เปิดผ่าน Tesla Browser ได้ทันที**
Real-time active engine sound for Tesla, running entirely in the in-car browser.

### ▶ เปิดใช้งาน / Live app
**https://preemak03.github.io/TeslaActiveSound/**

เปิดลิงก์นี้ใน Tesla Browser (หรือมือถือ) → กด **Start** → เลือกเสียงรถ → เปิด **GPS** ตอนขับจริง
No install, no account. Works offline after the first load.

---

## ✨ ฟีเจอร์ / Features

- **15 โปรไฟล์เสียงเครื่องยนต์** — NA V12, RB26, 2JZ, F20C, Flat-6 911, S58, Coyote V8, K20C VTEC, VR6, 4G63, LS V8, B58, Rotary, Electric Hyper, Classic Muscle
- **เกียร์เสมือน 3 สปีด** พร้อม kickdown + rev-match (ท้าย G3 ≈ 120 km/h)
- **เสียงตามการขับจริง** — อ่านความเร็ว GPS จริง หรือใช้โหมด Sim ปรับเอง
- **Launch Rev** — เบิ้ลเครื่องแบบควอเตอร์ไมล์ ลากรอบสับเกียร์ (ไม่ต้องขับ)
- **มิติหน้า–หลัง** — ย่านท่ออยู่หลัง ย่านเครื่องอยู่หน้า (psychoacoustic)
- **Drive Lock** — ล็อกปุ่มขณะขับเพื่อความปลอดภัย ปลดเมื่อจอดนิ่ง 3 วิ
- **ปรับตาม FPS ของรถอัตโนมัติ** (Tesla MCU2/MCU3) + ทำงาน offline

## 🎮 วิธีใช้ / Usage

| ปุ่ม | ทำอะไร |
|------|--------|
| **Push-to-Start** (ขวาล่าง) | ติด/ดับเครื่อง |
| **REV** (ข้างปุ่มสตาร์ท) | เบิ้ลเครื่องทดสอบเสียง |
| **Carousel** (กลางล่าง) | ปัดเลือกเสียงรถ |
| **GPS** (ขวาบน) | สลับความเร็วจริง (GPS) ↔ โหมด Sim |
| **Tune** (ซ้ายล่าง) | ปรับ Volume / Bass / Edge + สไลเดอร์ Sim |

> โหมด GPS ต้องอนุญาต Location ครั้งแรกครั้งเดียว · โหมด Sim เล่นได้โดยไม่ต้องใช้ GPS

## 🛠 เทคนิค / Tech

Vanilla JavaScript + Web Audio API — เสียงทั้งหมดสังเคราะห์สด ไม่มีไฟล์เสียง ไม่มี dependency
Pure client-side · no build step · no external libraries.

---

## 📄 License

**© 2026 PreeMak03 — All rights reserved.**

โค้ดเปิดให้ดูเพื่อความโปร่งใส แต่**สงวนลิขสิทธิ์** — ห้ามคัดลอก ดัดแปลง หรือนำไป re-host
โดยไม่ได้รับอนุญาต ดูรายละเอียดใน [LICENSE](LICENSE)

Made with ♥ for the Tesla Thailand community.
