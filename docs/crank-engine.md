# CRANK — เครื่องเสียงตัวที่สามของ TAS

> ที่มา: ต้นแบบ **CRANK** (soundforpreemak.grok.me) ที่เจ้าของโปรเจกต์ฟังแล้วโอเค
> โดยเฉพาะโปรไฟล์ **1JZ** และ **Civic** — ย้ายเข้ามาใน TAS แบบ *ไม่แก้เสียง*
> เปลี่ยนแค่ "RPM มาจากไหน"

---

## 1. TAS มีเครื่องเสียง 3 ตัวแล้ว

| Engine | ไฟล์ | เสียงมาจาก | โปรไฟล์ |
|--------|------|------------|---------|
| Classic | `js/audio-engine.js` | tone{} procedural | `assets/classic/*.classic.json` |
| VESSEL | `js/vessel-audio.js` + worklet | physical synthesis (.vsl) | `assets/vessel/*.rig.json` |
| **CRANK** | `js/crank-audio.js` | **firing-order wavetable** | `assets/crank/*.crank.json` |

`app.js` เลือกให้เองจาก id ของการ์ด (`engineKindFor()`):
`hasRig()` → VESSEL, `hasCrank()` → CRANK, ที่เหลือ → Classic
ถ้า engine ใดโหลดไม่ขึ้น → fallback เป็น Classic เสมอ (แอปไม่มีวันเงียบ)

---

## 2. CRANK ทำงานยังไง (first principles)

1. **เรียงจังหวะจุดระเบิด** — วางพัลส์แรงดันของทุกสูบลงบนตาราง 720° ตามลำดับจุดระเบิด
   (I6 = ทุก 120°, I4 = ทุก 180°; สูบในของ I4 เบากว่า 6% เพราะอยู่ไกล collector)
2. **แปลงเป็นสเปกตรัม** — DFT 384 ฮาร์มอนิก แล้วเอียงสโลป `1/n^tilt`
   พร้อมยก **order = จำนวนสูบ** (= firing order) และ octave ของมันขึ้นมา
3. **ออสซิลเลเตอร์ตัวเดียว** เล่น PeriodicWave นั้นที่ `rpm/120` Hz
   → ได้สเปกตรัมการเผาไหม้ครบทั้งชุดจาก osc ตัวเดียว
4. รอบ ๆ มัน: waveshaper (rasp) → หน่วงตามความยาวท่อ (`pipeM/343`) →
   lowpass ตาม brightness → peaking 2 ตัว (`exhaustHz`, `exhaustHz2`) →
   pan L/R + ชั้น intake / mechanical / induction (turbo spool หรือ VTEC)

**พิสูจน์แล้วว่าตรงฟิสิกส์** (จาก `_crank_verify.html`):

| เครื่อง | RPM | คาดว่าพีคที่ | วัดได้ |
|---------|-----|--------------|--------|
| 1JZ (I6) | 3000 | 25 Hz × 6 = 150 Hz | 141 Hz (bin 23.4 Hz) ✓ |
| 1JZ (I6) | 6000 | 50 Hz × 6 = 300 Hz | 305 Hz ✓ |
| Civic (I4) | 4000 | 33.3 Hz × 4 = 133 Hz | 141 Hz ✓ |
| Civic (I4) | 7200 | 60 Hz × 4 = 240 Hz | 234 Hz ✓ |

---

## 3. Lab / Runtime split — ทำไมไม่แลค

DFT 384 ฮาร์มอนิก × ตาราง 2048 จุด × 3 คลื่น (L/R/mono) × 2 แคม
= ~5 ล้าน float ops **ต่อโปรไฟล์**  บน MCU คือกระตุกทุกครั้งที่เลื่อนการ์ด

จึงย้ายไปทำ **offline** ที่:

```bash
node vessel/tools/build-crank.mjs
```

ได้ `assets/crank/{id}.crank.json` ที่มีค่าสัมประสิทธิ์คลื่นสำเร็จรูปแล้ว
แอปแค่ `createPeriodicWave()` — ไม่มี DFT, ไม่มีการสร้างตาราง, ไม่มี allocation

**ต้นทุนจริงที่วัดได้** (Chrome desktop, `_crank_verify.html`):

| รายการ | ค่า |
|--------|-----|
| `start()` ทั้งหมด (fetch + สร้างกราฟ) | **~80 ms ครั้งเดียว** |
| สลับโปรไฟล์ ครั้งแรก (ยังไม่ cache) | ~72 ms (ส่วนใหญ่คือ fetch) |
| สลับโปรไฟล์ หลัง cache | **4.7 – 9.4 ms** |
| `_tick()` เฉลี่ย | **0.09 ms** (รอบละ 20 ms → ~0.5% ของ 1 คอร์) |
| `_tick()` สูงสุด | 0.5 ms |
| จำนวน Web Audio node | 70 (native ล้วน ไม่มี worklet) |
| ขนาดไฟล์ | 1JZ 24 KB · Civic 48 KB (มี VTEC 2 ชุดแคม) |

กติกาที่ทำให้ไม่มีสไปค์:

- **ไม่ allocate ต่อ tick** ทุกพารามิเตอร์เป็น `setTargetAtTime` บน node ที่สร้างไว้แล้ว
- **pop ตอนยกคันเร่ง = envelope บน noise bed ถาวร** ไม่ใช่สร้าง node ใหม่ทุกครั้ง
  (node churn คือต้นเหตุ GC spike บน MCU)
- **`setInterval` 20 ms** (33 ms บน perf tier `lite`) ไม่ผูกกับ rAF
  → เสียงยังนิ่งตอน Tesla Browser เฟรมตก
- ไฟล์ JSON อยู่ใน `sw.js` precache แล้ว → fetch เป็น local ทุกครั้งหลังโหลดแรก

---

## 3.5 โมเดลเทอร์โบ 1JZ (ของจริง ไม่ใช่ลากเส้น)

**แก้ข้อมูลผิดจากต้นแบบ:** ต้นแบบเขียนว่า 1JZ-GTE เป็น *sequential twin-turbo*
— **ไม่ใช่** 1JZ-GTE Gen 1 (JZA70/JZX81, 1990–1995) ใช้ CT12A สองลูก **แบบขนาน
(parallel)** ลูกละ 3 สูบ ตัวที่เป็น sequential คือ **2JZ-GTE** ต่างหาก
แปลว่า **ไม่มีจังหวะ "โบลูกที่สองเข้ามา" ให้กระโดด** — มีแค่ threshold เดียวแล้วสวบยาว

สเปกโรงงาน Gen 1: **280 PS @ 6,200 rpm · 363 Nm @ 4,800 rpm · 8.5:1 · 0.7 บาร์ (10 psi)**

เส้นบูสต์ที่คอมไพล์ลง JSON (`boost{}` ใน `jz.crank.json`):

| RPM | บูสต์ | บาร์ | ความดุ (สเกล 1–10) |
|-----|-------|------|---------------------|
| 750–1,800 | 0% | 0.00 | **1.0** ← ยังไม่ติดโบ เรียบ ๆ แบบ I6 |
| 2,200 | 10% | 0.07 | 1.9 ← threshold เริ่มออก |
| 2,600 | 35% | 0.25 | 4.2 |
| 3,000 | 65% | 0.45 | 6.8 ← ช่วงสวบ |
| 3,400 | 90% | 0.63 | 9.1 |
| 3,800 | 100% | 0.70 | **10.0** ← เวสต์เกตคุมแล้ว |
| 4,800 | 100% | 0.70 | 10.0 ← แรงบิดสูงสุด (มาจาก VE ไม่ใช่บูสต์เพิ่ม) |
| 6,200 | 100% | 0.70 | 10.0 ← แรงม้าสูงสุด |
| 7,200 | 88% | 0.62 | 8.9 ← โบลูกเล็กหมดลม ปลายแบนลง |

จุดสำคัญ: **หัวเข่าอยู่ต่ำกว่าที่คิด** — สวบจบตั้งแต่ ~3,800 ไม่ใช่กระโดดที่ 4,500
และปลายไม่ได้ดุขึ้นเรื่อย ๆ แต่ **แบนแล้วตกนิดหน่อย** เพราะ CT12A คู่เล็กหมดลม

บูสต์ยังถูกคูมด้วย **load** (`loadLo/loadHi`) ด้วย → วิ่งเรียบ ๆ 2,500 rpm บูสต์เกือบศูนย์
เหมือนของจริง และเวลาถอนคันเร่งบูสต์ทิ้งเร็ว (`bleedSec` 0.16 วิ)

`offGain 0.6` = ตอนยังไม่ติดโบ เสียงท่อมีแค่ 60% ของตอนบูสต์เต็ม
นี่แหละคือ *"silk, then spool"*

---

## 3.6 แก้อาการกระตุกตอนใช้ speed sim

**อาการ:** กด Rev ไม่กระตุก แต่ลาก speed sim แล้วกระตุกมาก

**สาเหตุ:** Launch Rev ใช้สคริปต์ที่ *ไล่* รอบขึ้นลงแบบต่อเนื่อง แต่โหมดขับจริง
เกียร์เสมือน **กระชากรอบทันที** ตอนเปลี่ยนเกียร์ (6,426 → 2,056 rpm ใน 1 tick)
แล้ว CRANK ใช้ออสซิลเลเตอร์ตัวเดียว = เสียงคือ pitch ตรง ๆ
ตกลง 1.5 ออกเทฟใน 12 ms → ได้ยินเป็น "ป๊อก"

**แก้ 2 ชั้น (ค่าอยู่ใน JSON ทั้งคู่):**

1. `glideSec` / `shiftGlideSec` — ให้ pitch **ไถลตาม** รอบ ปกติ 30 ms
   ตอนเปลี่ยนเกียร์ยืดเป็น 90 ms (เครื่องจริงใช้เวลา ~0.1–0.2 วิ กว่ารอบจะตกขนาดนั้น)
2. `riseRpmPerSec` / `fallRpmPerSec` — **โมเมนต์ความเฉื่อยของเครื่อง** (ดู §7 — derive ให้ทุกโปรไฟล์)
   sim สั่งเร่งเต็มใน 1 เฟรม แต่ I6 เหล็ก 2.5 ลิตร + ฟลายวีลขึ้นรอบเร็วขนาดนั้นไม่ได้
   1JZ = 7,000 rpm/วิ (และ **หารครึ่งตอนยังไม่ติดโบ**) · K20 = 11,000 rpm/วิ

**วัดผล** (ช่วง pitch ที่กระโดดมากที่สุดต่อ 1 เฟรม 16 ms):

| | ก่อนแก้ | หลังแก้ |
|---|---------|---------|
| 1JZ | **7.07 semitone** (กระโดด) | **2.49 semitone** (ไถลต่อเนื่อง) |
| ออกตัว 750→2,150 rpm | ~50 ms | ~400 ms ไล่ขึ้นเรียบ |
| ตอนเปลี่ยนเกียร์ | ตก 12 ms | ไถล ~180 ms |

ต้นทุน `_tick` ไม่เปลี่ยน (0.098 ms เฉลี่ย)

---

## 4. ที่เปลี่ยนจากต้นแบบ (เปลี่ยนแค่นี้)

ต้นแบบเร่งด้วยคันเร่งบนจอ และคำนวณ RPM เอง
ในรถ RPM มาจากถนน — **ใช้โมเดลเดิมของ TAS ทั้งดุ้น** (`js/gearbox.js`):

```
GPS speed + accel → accelLoad/decelLoad → เกียร์จากช่วงความเร็ว (26/51/71/91)
→ rpmInGear() → RPM
```

ตรงตามกฎ *"RPM ∝ ความเร่ง ไม่ใช่ความเร็ว"* — ความเร็วคงที่ รอบตกลงมาที่ floor ของเกียร์

เพิ่มเข้ามาอีก 3 อย่าง ที่เป็น **ข้อมูลใน JSON ไม่ใช่ค่าลับใน engine**:

- `drive{}` — หน้าต่างรอบต่อเครื่อง (`revLo/revHi/revPull/floorLo/floorHi`)
- `dynamics{}` — Dynamic Volume ในรถ (idle ไม่ดังเท่าลากรอบ) ตั้งไว้เบา ๆ
- `inertia` จาก spec → ความหน่วงของเข็มรอบ (1JZ 0.95 อืดกว่า K20 0.5)

Bass/Edge = shelf ±5 dB **เป็นกลางที่ 50** → ค่าเริ่มต้นของการ์ด = เสียงต้นแบบเป๊ะ

---

## 5. ไฟล์ที่เกี่ยวข้อง

```
vessel/tools/build-crank.mjs     คอมไพเลอร์ (spec → JSON) — spec ต้นฉบับอยู่ในนี้
assets/crank/jz.crank.json       1JZ-GTE   (I6 turbo)
assets/crank/civic.crank.json    K20A      (I4 VTEC)
js/crank-rigs.js                 id map (เล็ก, import จาก app.js ได้)
js/crank-audio.js                ตัว engine
js/profiles.js                   การ์ด jz-crank / civic-crank
js/app.js                        engineKindFor() → เลือก engine 3 ทาง
sw.js                            precache (LAW 5)
vessel/tools/lab-serve.mjs       deploy ship list (LAW 5)
_crank_verify.html               หน้าทดสอบ: ต้นทุน + สเปกตรัม + ขับจำลอง
```

---

## 6. สถานะการปล่อย (LAW 7)

**Deploy แล้ว** (commit `60cce1d`, 2026-08-19) — อยู่ใน `live` ของ
`assets/vessel/live-set.json` แต่ **ไม่อยู่ใน `public`**
→ เห็นเฉพาะ **Dev mode** (กดค้าง 5 วิที่หัวข้อ tune sheet)
ลิงก์สาธารณะยังเป็น `classic-muscle` เหมือนเดิม ไม่มีอะไรเปลี่ยนสำหรับคนทั่วไป

การ์ดตั้ง `mix.master = 100` → เปิดมาดังเต็มเลย (วัดแล้ว peak 0.74 ที่ master 1.0
ไม่คลิป เหลือ headroom ~2.7 dB)

**ยังไม่ได้ commit ขึ้นไปด้วย** (ค้างอยู่บนเครื่อง เป็นงานคนละชุด):
`js/vessel-audio.js`, `js/vessel-runtime.worklet.js`, `assets/vessel/*.rig.json`
— งาน VESSEL base-sound ที่ยังไม่ได้ขับทดสอบ ถ้ากด CommandRoom Deploy ครั้งหน้า
ship list จะลากไฟล์พวกนี้ขึ้นไปด้วย **ตรวจก่อนกด**

**ก่อนดัน public ต้องขับทดสอบจริงในรถก่อน** — วัด *คุณภาพ* ไม่ใช่แค่ "ดังไหม":
ตอนนิ่ง, ออกตัว, เปลี่ยนเกียร์, ยกคันเร่ง (pop), ความเร็วคงที่, และเสียงแตกที่ volume จริง

## 7. CRANK TYPE DEFAULTS — บังคับใช้ทุกโปรไฟล์ ทั้งปัจจุบันและอนาคต

ทั้งเรื่อง **กันกระตุก** และ **โมเดลเทอร์โบ** ไม่ได้พิมพ์มือทีละเครื่อง
แต่ **คำนวณจาก spec ของเครื่องนั้นเอง** ใน `defaultsFor(spec)`
→ เพิ่มเครื่องใหม่ = ได้ทั้งชุดอัตโนมัติ **ลืมไม่ได้**

| ค่า | สูตร | เหตุผล |
|-----|------|--------|
| `glideSec` | `0.022 + inertia×0.012` | เครื่องหนักไล่รอบช้ากว่า |
| `shiftGlideSec` | `0.055 + inertia×0.038` | เวลาที่รอบตกตอนคลัตช์ออก |
| `glideHoldSec` | `shiftGlideSec × 2.2` | ค้าง glide ช้าไว้จนพ้นจังหวะเปลี่ยนเกียร์ |
| `riseRpmPerSec` | `redline ÷ (0.35 + inertia×0.7)` | ≈ "กี่วินาทีกวาดเข็มรอบ" |
| `fallRpmPerSec` | `rise × 1.25` | ถอนคันเร่งรอบตกเร็วกว่าขึ้น |
| `boost.onsetRpm` | `peakTorqueRpm × 0.375` | threshold โบ |
| `boost.fullRpm` | `peakTorqueRpm × 0.79` | เวสต์เกตเริ่มคุม |
| `boost.taperRpm` | `torquePeak + 62% ของระยะถึง redline` | ≈ จุดแรงม้าสูงสุด |
| `boost.spoolSec` | `0.26 + inertia×0.15` | แล็กตามมวลหมุน |
| `boost.offGain` | `0.42 + displacementL×0.072` | เครื่องใหญ่มีเสียงเหลือตอนยังไม่ติดโบ |

`induction: 'turbo'` → ได้ `boost{}` เสมอ · ไม่ใช่เทอร์โบ → `null`
spec จะ **override** ทีละค่าได้ด้วย `drive:{}` / `dynamics:{}` / `boost:{}`
แต่ไม่ override ก็ใช้งานได้ครบ (1JZ กับ Civic override แค่ *ช่วงรอบต่อเกียร์* เท่านั้น)

ตัวอย่างที่สูตรให้กับเครื่องอื่น (ยังไม่ได้ทำเป็นการ์ด แค่ตรวจสูตร):

```
S85   V10 NA 8250   glide 0.031/0.082s  rise  9700 rpm/s
GT3   F6  NA 9000   glide 0.029/0.077s  rise 11900 rpm/s   ← เบา รอบไว
RB26  I6 turbo      glide 0.033/0.088s  rise  8300 rpm/s   boost 1650→3500 @0.8 bar
B58   I6 turbo      glide 0.032/0.085s  rise  7700 rpm/s   boost 1900→3950 @1.0 bar
```

`js/crank-audio.js` ยังมี `DEFAULT_DRIVE` / `DEFAULT_BOOST` เป็นตาข่ายรับอีกชั้น
→ JSON เก่าหรือที่แก้มือแล้วขาดฟิลด์ ก็ยังได้พฤติกรรมนี้ (พร้อม warn ให้ recompile)

### เพิ่มเครื่องยนต์ใหม่

1. เติม spec ลงใน `SPECS` ใน `vessel/tools/build-crank.mjs`
   (ต้นแบบยังมี S85 V10 uneven-fire, GT3 boxer, Lambo V12 — โค้ด firing order รองรับหมดแล้ว)
   เทอร์โบให้ใส่ `boostBar` ของจริงด้วย
2. `node vessel/tools/build-crank.mjs` — จะพิมพ์ค่าที่ derive ให้ดูว่าสมเหตุสมผลไหม
3. เติม id ใน `js/crank-rigs.js`, การ์ดใน `js/profiles.js`, และ precache/ship list
