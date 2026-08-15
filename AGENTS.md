# AGENTS.md — Tesla Active Sound (BINDING)

> **นี่ไม่ใช่คำแนะนำ — เป็นกฏบังคับ (LAW)**  
> ละเมิดกฏเหล่านี้แล้วระบบพังตอนโปรไฟล์เยอะ (10 → 200) แบบที่เคยเกิดแล้ว  
> เจ้าของโปรเจกต์เขียนกฏนี้ไว้แล้ว ถูกละเลยครั้งหนึ่ง — **ห้ามซ้ำ**

ก่อนแตะ `js/audio-engine.js`, `js/dynamic-volume.js`, `js/profiles.js`,  
`assets/classic/*`, CommandRoom Classic, หรือ lab-serve classic-save  
**ต้องอ่านและทำตามเอกสารนี้ + `docs/CLASSIC-CONTRACT.md`**

---

## LAW 1 — จูนจบที่โปรไฟล์ (Tune finishes in the profile)

| ทำที่ | ไม่ทำที่ |
|--------|----------|
| `assets/classic/{id}.classic.json` | อย่า “ซ่อมเสียง” ใน `AudioEngine.update()` |
| CommandRoom Classic / classic-tool | อย่า hardcode บุคลิกเสียงเป็นค่าลับใน engine |
| `validateClassicProfile` ตอน Save | อย่า sanitize ทับค่า author ตอนเล่น |

**Source of truth เดียว:** ไฟล์ Classic JSON  
`js/profiles.js` = fallback / bootstrap เท่านั้น — JSON ชนะหลัง `loadClassicStandards()`

---

## LAW 2 — Engine = pure profile player

`AudioEngine` (และ math ใน `dynamic-volume.js`) มีสิทธิ์แค่:

1. **อ่าน** profile ที่ `resolveClassicProfile()` แล้ว  
2. แปลง input รถ (speed / accel จาก **app system**) → RPM/load  
3. เล่นเสียงตาม field ในโปรไฟล์  
4. Slew / damp **เพื่อ zipper เท่านั้น** — ห้ามเปลี่ยน intent ของ curve / body / volume  

**ห้าม:**

- `if (body < 0.15) body = 0.85` แบบบังคับทับจูน  
- `sanitizeCurveMul` ทับกราฟที่ author ตั้ง  
- บังคับ `idlePresence` / `dynDb` คนละค่าจากโปรไฟล์  
- shift mute ลับซ้อน dyn mute โดยไม่อยู่ใน `dynamics.shiftDuck`  
- ใส่ “personality” ใหม่ใน engine แทน field ในโปรไฟล์  

ค่า default ที่ขาด → เติมใน **`resolveClassicProfile` ครั้งเดียวตอน load/setProfile**  
ไม่เติม/ไม่ทับทุกเฟรม

---

## LAW 3 — Validate-at-save (ประตูเดียว)

ค่าพังต้อง **ตายตอน Save** ไม่ใช่ตอนขับรถ

- `js/classic-profile.js` → `validateClassicProfile` / `CLASSIC_LIMITS`  
- CommandRoom Save **และ** `POST /__lab/classic-save` **และ** `classic-tool` ใช้ชุดเดียวกัน  
- Save สำเร็จ → เขียน `resolveClassicProfile(doc)` ลงดิสก์ (โปรไฟล์ครบทุก field)  
- ช่วงค่าใน `assets/classic/fields.json` ต้องสอดคล้อง `CLASSIC_LIMITS`  

อย่า “ผ่อน” limits ใน engine แทนการ reject ที่ save

---

## LAW 4 — App system ≠ Sound profile

| Profile (ต่อการ์ด) | App system (ทั้งแอป) |
|--------------------|----------------------|
| engine / tone / mix / dynamics | Master volume slider |
| Dyn curve, dynDb, shiftDuck, gearScale | GPS smooth / deadband |
| waveguide ใน tone | Online carousel (`live-set.json`) |

อย่ายัด GPS smoothing เข้า tone  
อย่ายัด “แก้กระตุกบนรถ” เป็น hardcode ใน dyn ที่ทับทุกโปรไฟล์โดยไม่ document เป็น field

---

## LAW 5 — Ship contract

ทุก `import` ที่ production ใช้ ต้องอยู่ใน:

- Deploy ship list (`vessel/tools/lab-serve.mjs`)  
- `sw.js` precache (เมื่อเป็น shell/runtime)  

เคยพังแล้ว: `dynamic-volume.js` / `classic-profile.js` ไม่ขึ้น git → Classic พังบน Pages  
**Deploy แล้วตรวจว่าไฟล์ใหม่ติด commit**

Apply Online = แค่ carousel  
Deploy = โค้ด + JSON + runtime

---

## LAW 6 — ห้ามแก้ “บนรถ” ด้วยการทำลายสัญญา

เมื่อมีบั๊กบนรถ (กระตุก / ดังผิด):

1. ตรวจ **โปรไฟล์** ผ่าน validate หรือยัง  
2. ตรวจ **GPS / app path** (ถ้าเกี่ยวกับ speed)  
3. ถ้าต้องพารามิเตอร์ใหม่ → **เพิ่ม field ใน dynamics/tone + limits + fields.json**  
4. **ห้าม** ใส่ clamp ลับใน `update()` ที่ทำให้ “ค่าใน JSON ≠ เสียงที่ได้”

ถ้าทำข้อ 4 = วันที่มี 200 โปรไฟล์ **ตายทั้งชุด** เพราะจูนไม่มีความหมาย

---

## LAW 7 — คุณภาพของที่มีอยู่ > ฟีเจอร์ใหม่ที่ยังไม่มีใครใช้

**ห้ามยอมให้คุณภาพเสียงที่ใช้งานได้อยู่แล้วแย่ลง เพื่อแลกกับฟีเจอร์ที่ยังพิสูจน์ไม่ได้**

ลิงก์นี้ถูกแชร์ออกไปแล้ว คนที่เปิดครั้งแรกแล้วเจอเสียงแตก **ไม่มีครั้งที่สอง** — ความเสียหาย
ไม่ใช่แค่ "บั๊กหนึ่งตัว" แต่คือชื่อเสียงของโปรเจกต์

**เกิดขึ้นจริงแล้ว (v1.0.29):** เปลี่ยนทางออกเสียงไปเป็น `MediaStreamDestination → <audio>`
เพื่อให้เล่นต่อตอนหุบจอ — ฟีเจอร์ที่ยังไม่มีใครได้ใช้ — แล้วมันทำให้**เสียงแตกบนรถทุกคน**
ต้องถอยทั้งชุดใน v1.0.30

**กฎบังคับ:**

1. **แตะ audio graph / drive loop = ห้ามขึ้น production ถ้ายังไม่ได้ขับทดสอบจริง**
   เก็บไว้บน branch จนกว่าเจ้าของจะอยู่ในรถและพร้อมลอง — ขึ้นตอนนั้น ลองทันที
   ไม่ผ่านก็ถอยภายในไม่กี่นาที **ห้ามขึ้นทิ้งไว้ตอนเจ้าของทดสอบไม่ได้**
2. **การทดสอบต้องวัด "คุณภาพ" ไม่ใช่แค่ "ทำงานไหม"**
   ครั้งที่พลาดคือวัดว่าเสียงยังเล่นอยู่ตอนหุบจอ แต่ไม่ได้ตรวจว่าเสียงเพี้ยนหรือเปล่า
   ถ้าวัดจากเบราว์เซอร์ปกติแล้วบอกคุณภาพบน MCU ไม่ได้ → **แปลว่ายังทดสอบไม่ได้ อย่าขึ้น**
3. **ฟีเจอร์ใหม่ที่เสี่ยงต้องปิดไว้เป็นค่าเริ่มต้น** ผู้ใช้ทั่วไปต้องได้เส้นทางที่พิสูจน์แล้วเสมอ
   (เทียบเคียง: `live` vs `public` ใน `live-set.json` ที่ใช้กับโปรไฟล์อยู่แล้ว)
4. **ถอยทั้งก้อน ดีกว่าไล่แปะแก้** เมื่อของใหม่ทำให้ของเดิมแย่ลง — ย้อนกลับสถานะที่รู้ว่าดี
   ก่อน แล้วค่อยวิเคราะห์ ไม่ใช่แก้ทับไปเรื่อยๆ บน production

---

## เช็กลิสต์ก่อน commit (Classic)

- [ ] ไม่มี sanitize/override ใหม่ใน `audio-engine` ที่ทับ profile intent  
- [ ] field ใหม่ → `CLASSIC_LIMITS` + `fields.json` + default ใน `resolveClassicProfile`  
- [ ] `node vessel/tools/classic-tool.mjs validate` ผ่าน  
- [ ] ไฟล์ JS ใหม่ติด ship list + sw ถ้าจำเป็น  
- [ ] อ่าน `docs/CLASSIC-CONTRACT.md` ถ้าแตะ path เสียง Classic  
- [ ] **LAW 7:** ถ้าแตะ audio graph / drive loop — เจ้าของอยู่ในรถพร้อมลองหรือยัง? ถ้ายัง **อย่าขึ้น**  

---

## เอกสารอ้างอิง

| เอกสาร | เนื้อหา |
|--------|---------|
| **`docs/CLASSIC-CONTRACT.md`** | สัญญาเต็ม + ตัวอย่างถูก/ผิด |
| `vessel/standards/CLASSIC.md` | มาตรฐาน Classic ย่อ |
| `docs/COMMAND-ROOM.md` | Lab / Deploy |
| `js/classic-profile.js` | โค้ด enforce validate/resolve |

**VESSEL** คนละมาตรฐาน (`vessel/standards/v3.0-sealed/`) — อย่าปนสูตร Classic กับ VESSEL runtime โดยไม่ตั้งใจ
