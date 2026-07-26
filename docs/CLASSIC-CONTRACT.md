# Classic Profile Contract (LAW)

**สถานะ: BINDING — ไม่ใช่แนวทางแนะนำ**  
**ทำไมมีเอกสารนี้:** กฏ “จูนจบที่โปรไฟล์ · webapp โหลดน้อย · engine เป็น pure player”  
ถูกเขียนไว้แล้ว แต่ถูก**ละเลย**ระหว่าง feature (dyn volume, hybrid, แก้กระตุก)  
จนโปรไฟล์ไม่ใช่ source of truth → แก้ทีละใบไม่ได้เมื่อโปรไฟล์เยอะ

ถ้า AI / dev ทำลายสัญญานี้ = **regression ระดับสถาปัตย์** ไม่ใช่ “จูนไม่ดี”

---

## หนึ่งประโยค

> **เสียง Classic = ผลของ JSON โปรไฟล์เท่านั้น**  
> Engine เล่น · ไม่ตีความใหม่ · ไม่ซ่อมแทน author  
> ค่าพังถูกกันตอน **Save** ไม่ใช่ตอน **Drive**

---

## แผนภาพ

```
                    ┌─────────────────────────┐
   Author tools     │ CommandRoom / classic-  │
                    │ tool / lab-serve save   │
                    └───────────┬─────────────┘
                                │ validateClassicProfile()
                                │ resolveClassicProfile()
                                ▼
                    assets/classic/{id}.classic.json
                                │  SoT (complete on disk)
              boot              │
                    loadClassicStandards()
                    mergeClassicDoc()
                                ▼
                    SOUND_PROFILES[id]  (resolved)
                                │
                    AudioEngine.setProfile()
                                │
                    update(): READ ONLY + audio slew
                                ▼
                           Web Audio
```

**App system (นอกโปรไฟล์):** Master slider · GPS smoothing · live-set carousel

---

## ถูก / ผิด

### ✅ ถูก

```js
// setProfile — resolve ครั้งเดียว
this.profile = resolveClassicProfile(raw);

// update — อ่านอย่างเดียว
const body = this.profile.tone.body;
const curveMul = sampleVolumeCurve(rpm, this.profile.dynamics.curve);
const shiftDuck = this.profile.dynamics.shiftDuck;
```

```js
// save
if (!validateClassicProfile(doc).ok) reject;
write(resolveClassicProfile(doc));
```

### ❌ ผิด (เคยทำแล้วพัง)

```js
// ทับจูนตอนเล่น — ห้าม
if (tone.body < 0.15) body = 0.85;
curveMul = clamp(curveMul, 0.42, 1.15); // ถ้า author ตั้ง 0.5 ต้องได้ 0.5
if (idlePresence < 0.15) idlePresence = 0.75;

// mute ลับนอกโปรไฟล์ — ห้าม
dynVol *= 0.55; // ต้องเป็น dynamics.shiftDuck
layerGain *= 0.55; // ซ้ำ — ต้องใช้ shiftDuck ตัวเดียวจากโปรไฟล์
```

```js
// save ดิบไม่มี validate — ห้าม
fs.writeFileSync(path, JSON.stringify(doc));
```

---

## หน้าที่ไฟล์

| ไฟล์ | อนุญาต | ห้าม |
|------|--------|------|
| `assets/classic/*.classic.json` | เก็บจูนทั้งหมด | — |
| `js/classic-profile.js` | limits, validate, resolve, merge | ตรรกะเสียง DSP |
| `js/audio-engine.js` | เล่นตาม profile + physics input | แก้บุคลิกเสียงลับ |
| `js/dynamic-volume.js` | สูตรจากพารามิเตอร์ที่ส่งเข้า | default ทับ author |
| `js/profiles.js` | bootstrap + loadClassicStandards | SoT แทน JSON |
| `js/app.js` / geolocation | GPS, master, UI | เปลี่ยน tone โปรไฟล์ |
| CommandRoom / lab-serve | edit + validate + deploy | ข้าม validate |

---

## Field กลุ่มโปรไฟล์ (ครบ)

- **meta:** id, name, tag, car, accent, samplePack  
- **engine:** type, cylinders, idle/redline, gears, revLo/Hi/Pull…  
- **tone:** body, mid, high, sub, volume, filters, lope, waveguide…  
- **mix:** master/bass/edge defaults (starting UI)  
- **dynamics:** curve, dynDb, dynCeiling, loadBoost, shiftDuck, overrunDuck, floorBias, gearScale  

พารามิเตอร์ใหม่ที่กระทบ “ทุกคัน” ต้อง:

1. อยู่ใน JSON schema / `CLASSIC_LIMITS`  
2. มี default ใน `resolveClassicProfile`  
3. อ่านใน engine จาก `this.profile.*`  
4. ผ่าน `classic-tool validate`  

---

## ทำไมถึง “สำคัญที่สุด”

| ถ้าทำตามสัญญา | ถ้าละเลย |
|----------------|----------|
| จูน 1 ใบ = 1 ไฟล์ | จูนใน JSON ไม่ตรงรถ |
| 200 โปรไฟล์ scale ได้ | แก้ engine ที = พัง 200 ใบ |
| Lab กับรถพฤติกรรมใกล้กัน | Lab ลื่น รถกระตุก |
| Review ดู diff JSON | Review งมหา clamp ลับ |

การ “แก้กระตุก” ด้วย clamp ใน engine = **ยืมความเรียบร้อยวันนี้ เอาหนี้ทั้งกองโปรไฟล์คืนพรุ่ง**

---

## บังคับใช้ (enforcement)

1. **โค้ด:** `validateClassicProfile` บนทุก save path  
2. **เอกสาร:** `AGENTS.md` (root) ชี้มาที่นี่ — agent ต้องอ่านก่อนแตะ Classic  
3. **มาตรฐาน:** `vessel/standards/CLASSIC.md` สรุป + ลิงก์มาที่นี่  
4. **ทดสอบ:** `node vessel/tools/classic-tool.mjs validate`  
5. **Ship:** ไฟล์ contract runtime (`classic-profile.js`) ต้องอยู่ใน Deploy  

---

## ประวัติสั้น (อย่าซ้ำ)

- Dual SoT + merge `dynamics` หลุด → จูนกราฟแล้วเว็บไม่เห็น  
- `dynamic-volume.js` ไม่ ship → import พังบน Pages  
- เซฟ `body:0` / `volume:2` / curve ต่ำได้ → รถพัง  
- แก้ด้วย sanitize ใน engine → JSON ไม่มีความหมาย  

**หลังสัญญา:** validate-at-save + pure player + SoT = JSON

---

*Maintainer note: ถ้าต้องเบรก LAW ชั่วคราว ต้อง PR ที่อัปเดตเอกสารนี้และระบุวันหมดอายุ — ห้ามเบรกเงียบใน engine*
