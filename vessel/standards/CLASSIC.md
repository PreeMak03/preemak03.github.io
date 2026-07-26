# Classic Standard (AudioEngine)

Editable ship profiles for the **classic** procedural engine (`js/audio-engine.js`).

**Not VESSEL.** VESSEL is sealed under `vessel/standards/v3.0-sealed/`.

---

## ⛔ BINDING CONTRACT (อ่านก่อนแตะโค้ด)

**เอกสารเต็ม:** [`docs/CLASSIC-CONTRACT.md`](../../docs/CLASSIC-CONTRACT.md)  
**สำหรับ AI/agent:** [`AGENTS.md`](../../AGENTS.md) ที่ root โปรเจกต์

| # | กฏ | หนึ่งบรรทัด |
|---|-----|-------------|
| 1 | จูนจบที่โปรไฟล์ | SoT = `assets/classic/{id}.classic.json` |
| 2 | Engine = pure player | ห้าม sanitize/ทับค่า author ใน `update()` |
| 3 | Validate-at-save | ค่าพังตายตอน Save ไม่ใช่ตอน Drive |
| 4 | App ≠ Profile | Master/GPS = แอป · tone/dynamics = การ์ด |
| 5 | Ship ครบ | ทุก import production ต้อง Deploy จริง |
| 6 | ห้ามแก้รถด้วยการพังสัญญา | พารามใหม่ = field ใน JSON ไม่ใช่ clamp ลับ |

**ละเมิด = regression ระดับสถาปัตย์** (เคยเกิดแล้วเมื่อโปรไฟล์ยังน้อย — ที่ 200 ใบจะตายทั้งชุด)

---

## Source of truth

| Path | Role |
|------|------|
| `assets/classic/{id}.classic.json` | **SoT** — full profile (engine + tone + mix + dynamics) |
| `assets/classic/registry.json` | Index of classic ids |
| `assets/classic/fields.json` | Field schema (must match `CLASSIC_LIMITS`) |
| `js/classic-profile.js` | validate · resolve · merge · limits |
| `js/profiles.js` | Embedded fallback only; JSON wins after boot merge |

---

## CLI

```bat
node vessel/tools/classic-tool.mjs list
node vessel/tools/classic-tool.mjs dump classic-muscle
node vessel/tools/classic-tool.mjs set classic-muscle tone.body 1.0
node vessel/tools/classic-tool.mjs validate
```

`validate` / `set` / `save-json` ใช้ `validateClassicProfile` ชุดเดียวกับ lab-serve

---

## CommandRoom

```
http://localhost:8765/vessel/command-room/
→ tab Classic
```

Save → `POST /__lab/classic-save` → **validate + resolve** → write JSON  
Deploy includes `assets/classic/*` + `js/classic-profile.js` + runtime

---

## Runtime

1. Boot: `loadClassicStandards()` → `mergeClassicDoc` ต่อ id  
2. `AudioEngine.setProfile` → `resolveClassicProfile` (ครั้งเดียว)  
3. `update()` อ่าน `this.profile` อย่างเดียว (+ slew กัน zipper)

App boot merges JSON so ship can update tone **without** rewriting every number into `profiles.js` — แต่ **Deploy ยังต้อง ship ไฟล์ JSON**
