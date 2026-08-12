# Tesla Active Sound — Project Brief

> **Purpose of this file:** a single, self-contained explanation of the whole project to paste
> into an AI chat so it understands the system without reading the codebase. Written for
> machines first: explicit paths, data shapes, invariants, and the reasons behind them.
>
> **Status:** current as of app **v1.0.27** (2026-08-11). Verified against the repo, not memory.
>
> **If you are an AI working on this repo, read in this order:**
> `AGENTS.md` (binding law) → this file → `docs/CLASSIC-CONTRACT.md` (if touching sound) →
> `docs/VESSEL-HANDOFF.md` (if touching VESSEL).

---

## 0. TL;DR

**Tesla Active Sound (TAS)** is a browser web app that makes an electric car sound like a
combustion car. It synthesizes engine audio live from the car's **GPS speed** and plays it
through the cabin speakers. It runs in the Tesla in-car browser (and on phones) with **no
install, no account, no build step, no dependencies, no audio files** — every sound is
generated in real time with the Web Audio API.

There are **two independent synthesis engines** in the repo:

| | **Classic** (live, all shipped profiles) | **VESSEL** (built, sealed, not shipped) |
|---|---|---|
| Where | `js/audio-engine.js` | `js/vessel-runtime.worklet.js` + `js/vessel-audio.js` |
| Method | Layered procedural buffers + oscillators, tuned by JSON | Compiled half-order harmonic resynthesis from a physics lab |
| Tuning input | `assets/classic/*.classic.json` | `.engine.json` DNA → compiled `.vsl` rig |
| Status | **This is what users hear.** All active development. | Sealed. Not in the shipped carousel. Do not mix its formulas into Classic. |

A third, experimental engine (**order-synth**) exists on the `order-synth` git branch only.

---

## 1. What the product actually is

- **URL:** `https://preemak03.github.io/` (GitHub Pages **user site**, repo
  `PreeMak03/preemak03.github.io`, branch `main`). *(The `README.md` still prints an older
  `/TeslaActiveSound/` path — that is stale.)*
- **User flow:** open link → **Start** (push-to-start button) → optionally tap **GPS** →
  drive. Sound follows real speed. **REV** does a scripted launch so it can be demoed parked.
- **Owner:** PreeMak03 (Thai). Repo is public but `LICENSE` is **all rights reserved** —
  no forking/derivatives permitted without permission.
- **Monetisation:** none. A coffee/PromptPay donate QR and a feedback form, both optional.

### The core driving model (BINDING — the owner specified this)

> **RPM is driven by ACCELERATION, not by speed.** Gears come from speed bands.

- Holding a steady speed makes revs **fall** to that gear's standing floor (~1300 rpm in G1 →
  ~1800 rpm in G5). Accelerating lifts them toward the pull ceiling. Lifting off eases them down.
- Gear is chosen purely from road speed: **G1 1–25 · G2 26–50 · G3 51–70 · G4 71–90 · G5 90+**
  (`UP_AT = [26,51,71,91,999]`, downshift hysteresis `DOWN_AT = [12,34,54,74]` to stop GPS
  noise thrashing gears).
- This is why the app feels like a car and not a siren: the pitch tracks *effort*, not velocity.

---

## 2. Runtime architecture (what runs in the car)

```
 GPS receiver (or Sim slider)
        │  navigator.geolocation.watchPosition + a rate booster
        ▼
 js/geolocation.js ── speedKmh, accuracy, fixHz, speedSource ──┐
        │                                                       │
        ▼                                                       │
 js/app.js  tick()  (requestAnimationFrame)                     │
   • state.activeSpeed  ← ramp toward the newest fix            │
   • state.geoAccel     ← Δspeed / Δ(fix interval)   ★          │
   • state.accelKmhps   ← smoothed geoAccel (geo) or physics (sim)
   • audio.setSpeed(speed, { throttle, brake, accelKmhps })     │
        │                                                       │
        ▼                                                       │
 js/audio-engine.js  update(dt)  (its OWN setInterval @ 50 Hz)  │
   • _speedSmooth, _accelSmooth        → accelLoad / decelLoad  │
   • js/gearbox.js  resolveGear(speed) → gear, gearProgress     │
   • rpmInGear(...)                    → target rpm             │
   • rpm damp + "breathe" wander       → this._rpm              │
   • js/dynamic-volume.js              → dynVol (curve+duck)    │
   • layer gains / filters / playbackRate  (pushed @ 25 Hz)     │
        ▼                                                       │
 Web Audio graph → master → deharsh → compressor → dynGain →    │
   makeup → limiter → safety(WaveShaper) → analyser → speakers  │
                                                                │
 js/ui.js  SpeedDisplay ←────────────────────────────────────────┘
```

★ **The single most important line in the whole app.** See §7.1.

### Refresh rates (all three are deliberate)
| Stage | Rate | Why |
|---|---|---|
| GPS fixes | whatever the receiver gives (~1 Hz typical) | hardware limit; a booster polls for more, see §3 |
| `app.js tick()` | `requestAnimationFrame` (~60 fps, drops on the car MCU) | display + input plumbing only |
| `audio-engine.update()` | **`setInterval(…, 20)` = 50 Hz, independent of rAF** | so audio stays smooth when the car's rAF drops to 20–30 fps |
| AudioParam pushes | every 2nd engine tick = **25 Hz**, with an epsilon guard | `setTargetAtTime` spam is what the Tesla MCU audio thread hates |

`damp(current, target, lambda, dt)` in `js/animations.js` is exponential and **frame-rate
independent** — `1 - exp(-λ·dt)`. Lower fps therefore costs granularity, not lag. (One caveat:
`Ticker._frame` clamps `dt = Math.min(0.05, …)`, so below 20 fps simulated time runs slower
than wall time and a small lag accumulates.)

---

## 3. Stage 1 — GPS input (`js/geolocation.js`, 207 lines)

`GeolocationService` wraps `watchPosition` and emits `{ speedKmh, accuracy, status, lastFix,
fixHz, speedSource }` to subscribers.

Key behaviours, each of which exists for a specific reason:

- **`enableHighAccuracy: true, maximumAge: 0`** — never accept a cached fix; a 500 ms-old fix
  is 500 ms of latency. (`maximumAge: 500` used to be set, and it caused a real bug: the same
  fix was replayed, so speed deltas came out as 0 and acceleration read ~zero.)
- **Speed source:** prefer `coords.speed` (the receiver's own **Doppler** solution — fresh and
  already clean). Only if the browser withholds it do we derive speed from two positions
  (`_estimateSpeed`, haversine); that path is noisy and lags an extra fix. Reported as
  `speedSource: 'doppler' | 'derived'`.
- **Doppler speed is passed through UNSMOOTHED.** Averaging clean data only re-adds latency.
  The `derived` fallback keeps a light EMA (`prev*0.25 + kmh*0.75`) because it genuinely is noisy.
- **Teleport guard only:** reject a single-fix jump above **40 km/h**. It used to be 12, which
  at ~1 fix/s capped the readout at 12 km/h/s while the car pulls 16–30 — every launch drove
  the number progressively further behind the dash. **Never overwrite a change the receiver
  actually measured.**
- **Rate booster (`_startBoost`)** — also calls `getCurrentPosition({maximumAge:0})` between
  watch callbacks to lift the update rate as high as the hardware allows. Self-limiting:
  fixes are **deduped by timestamp**; a poll that returns a genuinely new fix keeps the
  interval at 200 ms; six duplicates in a row back it off toward a 2 s probe; and if the watch
  alone already yields ≥ 4 Hz the poll stops entirely.

### Why the app can never match the car's speedometer exactly
The dash reads **wheel/rotor sensors** — instantaneous. GPS is sampled (~1 Hz) and each fix
already describes a moment that has passed. A browser has **no access to the vehicle CAN bus**.
So a residual lag of roughly the sampling interval is physical, not a bug. Prediction /
extrapolation was tried and **rejected by the owner on principle** (do not fabricate input);
the accepted approach is to remove every delay the app adds itself and pass the measurement
through honestly.

---

## 4. Stage 2 — Speed → acceleration (`js/app.js`, 708 lines)

```js
// in geo.onUpdate(payload)  — runs once per NEW fix
const gdt = (nowMs - state.lastGeoMs) / 1000;
if (gdt > 0.06 && gdt < 4) {                       // 0.06 so booster fixes still count
  let a = (newSpeed - state.geoSpeed) / gdt;       // ← measured over the real interval
  a = clamp(a, -30, 30);
  state.geoAccel = state.geoAccel * 0.35 + a * 0.65;
}

// in tick(dt)  — geo branch
state.activeSpeed += (state.geoSpeed - state.activeSpeed) * Math.min(1, dt * 12);
state.accelKmhps += (state.geoAccel - state.accelKmhps) * Math.min(1, dt * 5);

// fed to the engine (BOTH modes use the same variable)
audio.setSpeed(state.activeSpeed, { throttle, brake, accelKmhps: state.accelKmhps });
```

**Sim mode** replaces the source only: `js/vehicle-physics.js` ramps toward the slider target
(max 33 km/h/s) and produces `speed`, `accelKmhps`, `throttle`, `brake` directly. One variable,
one consumer — that is what "one system" means here. See §7.1 for the trap.

Other things `app.js` owns: mode switching, engine start/stop, drive-lock (controls disable
while moving, unlock after 3 s stopped), dev mode, the profile carousel, the boot sequence, and
`window.TAS` (live debug getters — `TAS.audio`, `TAS.state`, `TAS.physics`).

---

## 5. Stage 3–4 — The Classic engine (`js/audio-engine.js`, 1943 lines)

An `AudioEngine` instance owns one Web Audio graph and one 50 Hz update loop.

### Sound generation
- `_makeEngineBuffer(spec)` pre-renders a **1.25 s looping buffer** of combustion pulses
  (thump + mid + rasp sines + noise burst + metallic ring per pulse, with uneven spacing for
  lope/boxer character), band-limited by 3× one-pole @ 2.6 kHz and crossfaded at the loop seam.
- Two such buffers (`low`, `high`) plus pink-noise buffers (`intake`, `turbo`, `whoosh`) are
  played through `BufferSource.playbackRate = rpm / REF_RPM` — pitch by time-stretching.
- Oscillators add `scream` (howl), `sub` (clean body), `lope`, `crank`.
- A `formant` filter tracks the 2nd firing order; `deharsh` (peaking 3 kHz) deepens with revs.

### Known limitation of this method
Stretching a whole buffer moves its **formants** with pitch, so every profile converges on a
similar timbre, and the sharp pulses alias when replayed fast (hence the 2.6 kHz crush, which
costs brightness). This is documented with a designed replacement in
`docs/soundbuildingpath.md` (order-based additive synthesis) — prototyped on the `order-synth`
branch, not shipped.

### Master chain (fixed order)
`master → deharsh → compressor → dynGain → makeup(2.0) → limiter(-1.5 dB, 12:1) →
safety(WaveShaper hard ceiling ≈0.985) → analyser → destination`

### Key runtime state and constants
| Name | Value | Meaning |
|---|---|---|
| update loop | `setInterval(…, 20)` | 50 Hz |
| `pushAudio` | every 2nd tick | 25 Hz AudioParam writes |
| `accelRefKmhps` | `16` | km/h/s that counts as **full** load |
| `_rpmCeiling` | `4800` | pitch-scale reference (see `pitchRpm`) |
| `_speedSmooth` λ | 8 | speed follow |
| `_accelSmooth` λ | 7 | load follow |
| `rpmLambda` | 3.6 cruise / 6–8.5 under load | rpm follow |
| `tau` / `fTau` | 0.14 / 0.16 s | `setTargetAtTime` constants |
| `_shiftRecover` | 0.7 s, caps λ at 2.4 | **requested feel**, not a bug — revs must sweep up through a new gear after an upshift instead of snapping to mid-gear |

### `pitchRpm` — per-profile rev scaling
Display rpm and every `rpmNorm`-based timbre reach the profile's **own** redline (a V12 shows
8900). But everything that sets an absolute played frequency — buffer `playbackRate` and the
firing-order oscillators — runs on
`pitchRpm = idle + (rpm-idle)·(min(redline,4800)-idle)/(redline-idle)`,
mapping any redline onto the proven-safe ~4800 firing band. Tesla drivers turn to "ซ่า"
(hissy aliasing) above that. For `classic-muscle` (redline 4500) `pitchRpm === rpm` exactly.

### RPM "breathe"
Real revs never sit frozen. `update()` adds a lope-scaled wander (±18–80 rpm, stronger low in
the range) into `this._rpm` itself, so both the readout and the pitch dance. Near the ceiling a
governor-style hunt replaces it.

### Anti-alias fix worth knowing
The `low` pulse buffer aliases badly when stretched. It is crossfaded to **silent by 850 rpm**
(`clamp(1-(rpm-650)/200,0,1)`) and the clean `sub` oscillator is lifted to keep the body. This
removed a long-standing "บึบๆ / ปะปะปุปุ" artefact.

---

## 6. Data model — profiles are the tuning surface

### `assets/classic/{id}.classic.json` (schema `tas-classic/1`)
```jsonc
{
  "schema": "tas-classic/1", "standard": "classic-audioengine/1",
  "id": "classic-muscle", "name": "Classic Muscle", "tag": "Lopey V8",
  "car": "Old school American", "accent": "rgba(180,83,9,.55)",
  "engine":  { "type":"ice", "cylinders":8, "idleRpm":650, "redlineRpm":4500,
               "gears":[3.2,2,1.4,1.05,.85], "revLo":.15, "revHi":.82, "revPull":.96 },
  "tone":    { "harmonics":[…], "body":.5, "mid":.42, "high":.5, "sub":.8, "scream":.05,
               "metallic":.03, "lope":.85, "turbo":0, "crackle":.12, "resonance":.95,
               "filterIdle":80, "filterRedline":4500, "waveguide":0, … },
  "mix":     { "master":100, "bass":95, "edge":5 },
  "dynamics":{ "dynDb":14, "dynCeiling":.88, "loadBoost":.22, "shiftDuck":.9,
               "overrunDuck":.9, "gearScale":[…5], "curve":[[rpm,vol]×6] }
}
```
- `assets/classic/registry.json` — the list of profile files to load.
- `assets/classic/fields.json` — UI metadata + ranges; must agree with `CLASSIC_LIMITS`.
- `js/classic-profile.js` — `CLASSIC_LIMITS`, `validateClassicProfile`, `resolveClassicProfile`
  (fills defaults **once** at load), `mergeClassicDoc`.
- `js/profiles.js` — `SOUND_PROFILES` is only a **fallback/bootstrap**; after
  `loadClassicStandards()` the JSON wins.

### `assets/vessel/live-set.json` — what ships
```jsonc
{ "live":   ["classic-muscle","na-v12","s85-v10","flat6-911","2jz"],   // Online set
  "public": ["classic-muscle"],                                        // normal users see only these
  "versions": {…}, "global": {…}, "cars": {…} }
```
`getVisibleProfiles()` returns `public` for normal users and the full `live` set in **dev
mode** — this is how not-yet-vetted profiles are staged without exposing them.

### `assets/version.json`
`{ "v": "1.0.27", "at": "…" }` — semver, shown top-left in the app. **Bump on every deploy**
(PATCH for tunes/fixes, MINOR for features). It is the only way to confirm in the car which
build actually loaded.

---

## 7. The two traps that have cost the most time

### 7.1 Acceleration must be measured over the interval it happened in
From v1.0.9 to v1.0.26 the app computed
`accelUni = d(activeSpeed)/dt` **every frame** and fed that to the engine. It looks like the
same quantity. It is not.

- **Sim mode:** physics moves speed every frame → continuous signal → the derivative is
  continuous → **works**.
- **GPS mode:** fixes land ~1 Hz → `activeSpeed` ramps to each fix and then sits **flat** →
  the derivative is a brief spike followed by ~zero → **load swung 0.14 ↔ 0.80 every second**.
  The engine surged and sagged instead of pulling. Raising the follow λ from 6 to 12 made it
  *worse* (faster ramp = shorter spike = longer dead gap).

The fix (v1.0.27) is to take acceleration from the **fix-to-fix delta** (`state.accelKmhps`),
which persists as a rate physically should. Verified in the running app against a stubbed 1 Hz
receiver pulling 25 km/h/s: the fed value holds 24.5–25.0 for the whole pull.

**Rule:** a derivative is only valid at the rate its source actually changes. Never differentiate
a smoothed display value to recover an input quantity.

### 7.2 A profile field can silently enable an expensive code path
`tone.waveguide > 0` lazily loads `js/engine-waveguide.worklet.js` — a per-sample JS
AudioWorklet. `classic-muscle` was once tuned to `waveguide: 0.28`, which put constant DSP on
the Tesla MCU audio thread and caused severe stutter, worst in GPS mode. Eight versions of perf
"optimisation" (update-rate cuts, node pruning, GPS downgrades) were spent chasing it and all
were reverted. **The fix was one field: `waveguide: 0`.**

**Rule:** when the car stutters, first diff the tuned profile against an untuned one for a field
that switches on machinery. Only then look at code.

### Other regressions worth not repeating
- A **looping** silent `<audio>` element added for iOS audio unlock ran on the Tesla too and
  stole the audio thread. It is now iOS-only and one-shot.
- A 153 KB donate QR PNG was fetched and decoded **at boot** for a modal almost nobody opens.
- `backdrop-filter: blur()` on three full-screen overlays is real GPU cost on the MCU.
- Anything not needed for driving now lives in `js/extras.js`, `import()`-ed on first tap and
  **fully destroyed on close** (nodes, stylesheet and listener removed — "closed" must mean
  gone, not `hidden`).

---

## 8. VESSEL — the sealed second engine

A separate, physically-modelled synthesis stack. **Not shipped**; do not blend its formulas
into Classic. Full detail in `docs/VESSEL-HANDOFF.md` and
`docs/vessel-production-architecture.md`.

```
 Engine DNA (.engine.json, 44 causal params)      Sound Profile (16 capture params)
        \                                                /
         ▼ ── VESSEL LAB (heavy, offline, never ships) ──
            vessel/lab/physics.js    crank pulses + exhaust waveguide (deterministic)
            vessel/lab/analyze.js    crank-angle DFT → half-order quadrature coefficients
            vessel/lab/formants.js   residual → calibrated band gains
            vessel/lab/compiler.js   loops the above over an (rpm × load) grid → .vsl
         ══ THE SEAM: enginePressure + TelemetryFrame ══
         ▼ ── VESSEL RUNTIME (thin, would ship) ─────────
            js/vessel-runtime.worklet.js
              LOW  band = additive half-order harmonic bank (Chebyshev recurrence),
                          coefficients bilinearly interpolated over (rpm, load)
              HIGH band = crank-locked impulse → 6 formant bandpass biquads
              + idle lope, misfire, governor hunt, mechanical layer
            js/vessel-audio.js  drop-in replacement for AudioEngine's interface
```

**Its seven binding principles:** engine DNA never depends on the sound profile; the profile
never changes DNA; everything expensive happens in the Lab at compile time; the runtime is
playback, not research; every parameter must map to a real acoustic or mechanical phenomenon;
presets must be deterministic and portable (**no `Math.random()` or wall-clock in the signal
path** — a seeded PRNG travels in the profile); and anything that does not improve authenticity,
tunability, portability or runtime efficiency does not ship.

Model in one line: a 4-stroke cycle is 720° = 2 revolutions, so the lowest component is the
**0.5 engine order**; `enginePressure(θ) = Σ coefSin[p]·sin(a_p) + coefCos[p]·cos(a_p)` with
`a_p = p·π·θ/360` and N = 24 partials. Cross-plane versus flat-plane character lives entirely
in those coefficient tables. Flagship preset: `camaro-restomod` (LS7 cross-plane V8, idle 780,
redline 6500), compiled hash `fb7a986a`.

---

## 9. Tooling, deploy and testing

| Thing | How |
|---|---|
| Serve locally | `serve.bat` → `node vessel/tools/lab-serve.mjs` on **:8765** (static + Lab API) |
| CommandRoom (Lab UI) | `http://localhost:8765/vessel/command-room/` — **localhost only, never ships** |
| VESSEL tuning bench | `vessel/bench/index.html` |
| Order-synth bench | `vessel/bench/order-bench.html` (branch `order-synth`) |
| Validate profiles | `node vessel/tools/classic-tool.mjs validate` |
| Build a VESSEL rig | `node vessel/tools/build.mjs` → `assets/vessel/camaro.rig.json` |
| Deploy | commit + push to `main`; GitHub Pages serves it |
| Service worker | `sw.js`, cache `tas-v38`, **network-first** → a deploy lands on the next online open |
| Live debug | `window.TAS` — `TAS.audio` / `TAS.state` / `TAS.physics` are live getters |

### Verification patterns that actually work here
1. **Node simulation of the model** — construct `AudioEngine`, set a profile, call
   `_updateRpmGear(dt)` directly. No audio nodes needed; proves rpm/gear logic.
2. **`OfflineAudioContext` render** — measure peak/RMS/brightness to compare timbres objectively.
3. **Stub `navigator.geolocation`** in the live page and read `window.TAS` — the only way to
   test the GPS path without driving.
4. **Module HTTP cache is sticky.** Bust it with `fetch(url, {cache:'reload'})` then reload, or
   dev changes appear to do nothing.

---

## 10. UI structure (`index.html` + `css/main.css`)

- **Top bar:** brand + version · donate chip (coffee) · GPS chip · theme toggle.
- **Drive stage:** big speed ring, rpm/gear line, drive-state chip, vertical acceleration tube.
  A dev-only GPS telemetry line (`doppler · 4.2 Hz · ±5m`) sits here on purpose — the tune sheet
  is locked while moving, and those numbers only mean anything while moving.
- **Bottom row:** feedback FAB + tune FAB (left) · profile carousel (centre) · REV + push-to-start (right).
- **Tune sheet:** end-user sees Sound (Bass/Edge) + Master Volume. **Dev mode** (triple-tap the
  tune button, persisted in `localStorage['tas-dev-mode']`) reveals the sim speed slider,
  behaviour toggles and telemetry. A 5 s long-press was tried first and does **not** survive the
  Tesla browser, which fires `contextmenu`/`pointercancel` mid-hold.
- **Drive lock:** `.drive-lock` dims and disables `.tune-fab`, `.launch-btn`, `.top-actions` and
  the carousel while moving. It deliberately does not touch `.speed-core`.
- **Onboarding:** first-run coach marks (`js/onboarding.js`), spotlight + tooltips, Thai copy.
- **A first-run trap that was fixed in v1.0.26:** the app boots into **sim** mode, but the sim
  speed slider is dev-only — so a new user pressing Start heard idle and nothing else, and
  reported "there's only bass, no revving". Starting the engine without a real speed source now
  says which control to press and breathes a ring on the GPS chip for 15 s.

---

## 11. Constraints an assistant must respect

1. **`AGENTS.md` is law.** Tuning finishes in the profile JSON. The engine is a pure profile
   player. Bad values die at save time (`validateClassicProfile`), never at drive time. Never
   add a hidden clamp in `update()` that makes the JSON stop matching the sound — with 200
   profiles that makes tuning meaningless.
2. **Never fabricate input.** No predicting or extrapolating GPS speed. Remove the app's own
   distortion instead; the residual latency belongs to the API and is stated honestly.
3. **The Tesla MCU is weak.** No per-sample JS on the audio thread. No permanent media streams.
   No full-screen blur. Nothing that is not driving may cost anything while driving.
4. **Deploy = bump `assets/version.json`.** Without it nobody can tell what is running in the car.
5. **The owner tests in a real car and cannot test on demand.** Prove changes with simulation
   plus the live-page harness *before* shipping, and change one thing at a time so a regression
   is attributable.
6. **Do not touch VESSEL formulas from Classic work**, and do not resurrect the `order-synth`
   branch into `main` without being asked.

---

## 12. Glossary of Thai terms used in this project's history

| Thai | Meaning in context |
|---|---|
| กระตุก | stutter / dropouts (usually MCU load) |
| ดีเลย์ | latency |
| แตก / ซ่า | harsh, raspy, hissy distortion — usually aliasing, not clipping |
| บึบๆ / ปะปะปุปุ | the low-buffer aliasing artefact (fixed by the 850 rpm fade) |
| รอบ | engine RPM |
| ยืนพื้น | the standing/floor rpm a gear settles at |
| ถอนคันเร่ง | lift-off / overrun |
| หนวกหู | fatiguing, too loud at cruise (the reason for the cruise duck) |
| เบิ้ล | blip the throttle / rev it |
| จูน | tune |

---

*Maintained at `docs/PROJECT-BRIEF.md`. Companions: `AGENTS.md` (law),
`docs/CLASSIC-CONTRACT.md` (sound contract), `docs/VESSEL-HANDOFF.md` (VESSEL),
`docs/soundbuildingpath.md` (the researched next-gen synthesis plan),
`docs/thor_ref.md` (competitor analysis).*
