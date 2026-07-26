# Hybrid Classic ↔ VESSEL — enable/disable & rollback

## Hear before ship (CommandRoom)

```
serve.bat → http://localhost:8765/vessel/command-room/
```

| Tab | Engine | What you can toggle while listening |
|-----|--------|-------------------------------------|
| **Classic** | `AudioEngine` | Form fields · **Waveguide** on/off + mix · Launch Rev · spectrum |
| **VESSEL** | `VesselAudio` + rig | **Waveguide** · **Hybrid stability** · **Organic v2** · WG gain · Launch Rev |

Paths are rooted via `window.__TAS_*` so worklets load from `/js/...` even under `/vessel/command-room/`.

## Soft toggles (preferred — no file restore)

All live on `synthesis{}` in rig / deploy, or `port.postMessage` / Classic `tone{}`.

| Flag | Default | Effect |
|------|---------|--------|
| **`hybridStability`** | `true` | **A** smooth RPM/load · **B** sub HPF ≥30 Hz · **C** LPF ceiling ≤1800 |
| **`antiStatic`** | `true` | Filter-coeff smooth (no zipper) · soft fire · partial cap · noise gate |
| **`globalMaxLpf`** | `1800` | Hard HF clamp (Hz) for brickwall / pulse trackers |
| **`organicV2`** | `true` | Load lag, timing LFO, tip-in drive (no pink pops) |
| **`waveguide`** | `false`* | DasEtwas exhaust bus (*Gentle deploy sets `true`) |
| **`waveguideGain`** | `0.28` | Mix level when waveguide on |
| **`waveguideIntake`** | `0` | Keep 0 for dark muscle |
| Classic **`tone.waveguide`** | `0` | Hybrid WG in AudioEngine (classic-muscle uses `0.28`) |

### Examples

Disable waveguide only (keep multi-bus + hybrid clamps):

```json
{ "waveguide": false }
```

Disable Classic-like param smoothing (debug only):

```json
{ "hybridStability": false }
```

Disable organic v2 dynamics:

```json
{ "organicV2": false }
```

Classic Muscle — turn off waveguide:

```json
"tone": { "waveguide": 0 }
```

CommandRoom Classic editor: set field **Waveguide exhaust mix** to `0`.

---

## Hard file rollback (worklet snapshots)

```bat
REM pre-waveguide multi-bus (no DasEtwas bus)
copy /Y js\vessel-runtime.worklet.pre-waveguide-backup.js js\vessel-runtime.worklet.js
copy /Y js\vessel-runtime.worklet.pre-waveguide-backup.js vessel\runtime\vessel-runtime.worklet.js

REM pre-v3 (fix3 monolithic)
copy /Y js\vessel-runtime.worklet.pre-v3-backup.js js\vessel-runtime.worklet.js

REM Classic AudioEngine pre-waveguide
copy /Y js\audio-engine.pre-waveguide-backup.js js\audio-engine.js
```

Or run: `rollback-vessel.bat` (if present) / see `ROLLBACK-DSP.md`.

Then **hard-refresh** the browser (worklet cache).

---

## Hybrid remediation map (this build)

| Spec | Implementation |
|------|----------------|
| **A** Phase / param continuity | `rpmSmoothed` / `loadParamSmoothed` exp toward AudioParams (`HYBRID_RPM_TAU` ~28 ms) |
| **B** Sub-sonic DC | Sub sine floor ≥30 Hz + one-pole HPF (`subHpfHz`) |
| **C** HF rasp clamp | `GLOBAL_MAX_LPF=1800` on pulse LPF + master brickwall + 3 kHz notch |
| Pops / backfire grit | Pink residual & overrun pink pops **off**; fire env soft attack/decay |
| Classic weight | Sub bus locked sine + pulse lope; optional WG only if flagged |
| VESSEL dynamics | Gear `txScale`, multi-bus, DNA fireAngles → WG crank offsets |

---

## Architecture (dual system)

```
Classic path (AudioEngine)
  pulse buffers + layers + cabin EQ
  + optional engine-waveguide.worklet  [tone.waveguide]
  → already damp() RPM on host

VESSEL path (vessel-runtime.worklet)
  Sub HPF@30 → Pulse LPF≤1200 → [WG if on] → sum
  → gear scale → tanh → brickwall≤1800 → notch 3k
  hybridStability smooths rpm/load into that chain
```

Two engines stay **separate** in the app (`ensureEngineFor`); hybrid means **shared DSP ideas + toggles**, not one mono blob.
