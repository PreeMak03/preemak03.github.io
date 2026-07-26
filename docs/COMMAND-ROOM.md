# CommandRoom (VESSEL Lab)

**Not shown in the Tesla user app.** Local author tool only.

## Start

```
B:\TeslaActiveSound\serve.bat
→ Node lab-serve (required for Apply / Deploy / Classic save)
→→ http://localhost:8765/vessel/command-room/
```

Plain `python -m http.server` can browse files but **cannot** push to GitHub.

## Online vs Deploy (read this first)

| ปุ่ม | ขึ้น GitHub อะไร | ผลบนเว็บจริง |
|------|------------------|---------------|
| **Apply Online** | แค่ `assets/vessel/live-set.json` | เปลี่ยน **รายชื่อการ์ด** ใน carousel เท่านั้น **ไม่** อัปเดตเสียง/โค้ด/DSP |
| **Deploy** | live-set + `js/*` + rigs + `assets/classic/*` + `sw.js`… | โค้ด + เสียง + โปรไฟล์จริง |

ถ้า Deploy ครั้งแรก: ต้อง tick โปรไฟล์ในแท็บ Deploy แล้วกด **Deploy to GitHub** (ต้องรัน `serve.bat` / lab-serve)  
ดู commit บน GitHub ว่ามีไฟล์ `js/vessel-audio.js` / `assets/classic/` หรือยัง — ถ้ายังไม่มี แสดงว่ายังไม่ ship เต็ม

## Online tab

1. Tick profiles (iOS switches)
2. **Apply Online → GitHub** → carousel list only
3. Status: `lastPush.ok` + commit hash
4. ~1–2 นาทีหลัง Pages build + hard refresh (หรือล้าง SW ครั้งแรก)

## Deploy tab

1. Tick profiles + versions  
2. **Deploy to GitHub**  
3. Rebuilds VESSEL rig (build.mjs), writes live-set, **git add ship files**, commit, push  
4. ต้องเห็น commit ข้อความประมาณ `Deploy ship + Online (...)`

## Classic tab

Edit **every** Classic AudioEngine variable (`engine` / `tone` / `mix` / meta).

- Source of truth: `assets/classic/{id}.classic.json`
- Field schema: `assets/classic/fields.json`
- CLI: `node vessel/tools/classic-tool.mjs help`
- Save → `POST /__lab/classic-save` (lab-serve only)
- User app merges JSON via `loadClassicStandards()` on boot

### Classic tab — Listen + Launch Rev

Same Classic `AudioEngine` as the main app:

1. **▶ Start audio** — form profile → buffers (+ optional waveguide)  
2. Edit fields (**Live apply**) or **Apply form → audio**  
3. **Waveguide exhaust** checkbox + **WG mix** (writes `tone.waveguide`)  
4. **Hold RPM** / speed / throttle  
5. **🚀 Launch Rev** — G1→G2→G3 (5s)  
6. Spectrum / band scope (mute-solo)  
7. **Save Classic JSON** when happy  

### VESSEL tab — Listen before Deploy

Same `VesselAudio` + ship rigs (`gentle` / `camaro` / `american` / `rotary`):

1. Pick rig → **▶ Start audio**  
2. Live toggles (no save required to hear):
   - **Waveguide exhaust** + gain  
   - **Hybrid stability** (RPM smooth + HF/sub clamps)  
   - **Organic v2**  
3. Hold RPM / load · **🚀 Launch Rev**  
4. Then Apply Online / Deploy when satisfied  

Leaving Classic or VESSEL tab stops that tab’s audio (saves CPU).

VESSEL multi-bus runtime is **sealed** separately:

```
node vessel/tools/seal-vessel.mjs
→ vessel/standards/v3.0-sealed/
```

CommandRoom button **Re-seal VESSEL** calls `POST /__lab/vessel-seal`.

## Files

| Path | Role |
|---|---|
| `vessel/tools/lab-serve.mjs` | Static + `/__lab/*` API |
| `vessel/tools/classic-tool.mjs` | Classic CLI editor |
| `vessel/tools/seal-vessel.mjs` | Freeze VESSEL standard |
| `assets/vessel/live-set.json` | **Shipped** Online set + status |
| `assets/classic/*.classic.json` | **Shipped** Classic standard profiles |
| `vessel/standards/v3.0-sealed/` | Frozen VESSEL baseline (do not edit) |
| `vessel/command-room/*` | Lab UI only |

## User app

`js/profiles.js` → `loadLiveSet()` + `loadClassicStandards()` on every host.  
No listen-HUD / in-car tuning tools.
