# THOR Active Sound — Reference Notes (`thor_ref`)

> Research snapshot for Tesla Active Sound design discussion.  
> Sources: THOR official site (thor-tuning.com), Thor EV (thor-tuning.be), FAQ / product pages, app/install docs, public reviews.  
> Not affiliated with THOR. For internal product design only.

## Adoption status (project decision)

**THOR control model is the primary design reference** for Tesla Active Sound:

| THOR idea | Our implementation |
|-----------|-------------------|
| Drive states idle/pull/cruise/overrun/shift | `audio-engine` `_driveState` |
| Virtual gearbox on EV | 3-speed map, top of 3rd ≈ 120 km/h (`gearbox.js`) |
| Multi-layer mix (≤7) | Sample layers + procedural fallback (`sample-pack.js`) |
| Load from throttle | Accel km/h·s + sim demand |
| Free/open sample packs | `docs/samples_ref.md` + `assets/samples/` |

Commercial THOR packs are **not** used. Free/CC sources only — see `samples_ref.md`.

---

## 1. What THOR is

**THOR** (THOR Tuning / Car Systems) is a commercial **electronic active exhaust / active sound** platform:

- Hardware **speakers under the car** (not cabin-only fake engine)
- **Control unit** in the cabin
- **Mobile app** (iOS / Android) for profiles, volume, tuning
- Connects to vehicle **CAN bus** (read-only) to sync sound with driving

Product lines relevant to us:

| Line | Audience |
|------|----------|
| **THOR** (classic) | ICE / diesel / hybrid — uses real RPM when available |
| **Thor EV** | Full EVs (Tesla, Taycan, etc.) — no combustion RPM; uses drive signals + **virtual gearbox** |

Also used heavily on Tesla (Model 3/Y etc.) in aftermarket community.

---

## 2. Hardware architecture

### 2.1 Speakers (frequency-split, multi-driver)

| Module | Role | Notes |
|--------|------|--------|
| **THUNDER 2.0** | Low / bass foundation | Deep exhaust body; metal housing |
| **STORM** | Mid (and some high) | Balanced “classic + futuristic”; often cited for EV |
| **ECHO** | High detail | ~700 Hz – 7000 Hz; clarity, edge, “air” |

Configs = **LEVEL 1–4**: 1–2 main cans ± ECHO. More drivers = more dB + richer spectrum (not just louder).

**Design takeaway:** realism = **split bands**, not one mono synth bus. Our app can mirror this with layer gains (sub / body / mid / high / crackle).

### 2.2 Control unit

- Reads vehicle data over **CAN** (adapter; claimed **no write** to vehicle ECU)
- BLE to phone app
- Cloud / OTA for sound packs & firmware
- Amp + processing on-unit

### 2.3 Installation (EV)

1. Mount speaker(s) underbody (universal bracket)  
2. Wire control unit to **CAN + power**  
3. Connect components  
4. Pair **THOR App**, pick vehicle **CAN profile**

---

## 3. How the sound engine works (claimed / documented)

### 3.1 Content model — not pure synth

THOR’s main claim for “realistic ICE” profiles:

1. **Record real cars** under load (idle, accel, lift-off, etc.)
2. Rebuild with proprietary **TRS** technology
3. Playback is **multi-layer** — **up to ~7 layers**, not one linear sample
4. Layers cover: **idle · acceleration · RPM build · throttle lift-off · pops/bangs**

This is closer to **game audio / sample-based active sound** than to pure oscillator synthesis.

### 3.2 Real-time drivers (ICE)

From CAN (examples they document):

- Engine **RPM**
- **Throttle / accelerator pedal** position
- Acceleration / driving dynamics
- Braking activity
- Other vehicle parameters

Sound **pitch, intensity, and layer mix** follow these in real time.

### 3.3 Real-time drivers (EV) — critical for us

EV has **no engine RPM**. THOR EV FAQ states they read e.g.:

- **Vehicle / wheel speed**
- **Throttle position**
- **Braking**
- Other drive parameters  

Then:

- Generate sound in real time  
- **Virtual gearbox simulation** for EV:
  - upshifts on accel  
  - downshifts under strong accel / aggressive input  
  - multi-downshift behavior  
  - **rev-matching** effects  
  - sound is **non-linear** (not only pitch∝speed)

**Design takeaway for Tesla Active Sound:**

| THOR EV | Our app (browser) |
|---------|-------------------|
| CAN throttle | GPS accel Δv/Δt + sim fader demand |
| Wheel speed | GPS speed / sim vehicle speed |
| Virtual gearbox | Our 3–5 gear map |
| Multi-layer samples | Procedural loops + layers (weaker realism) or future samples |
| Underbody speakers | Cabin / phone / Tesla cabin speakers only |

We cannot match hardware SPL or multi-can spectrum in browser — but we **can** match the **control philosophy**.

### 3.4 App-side tuning knobs (useful UX ref)

Documented user controls:

- Profile library (30+ packs; packs downloadable)
- Volume
- **Idle** tone / level (separate band of RPM or “idle region”)
- **Working cycle** / cruise tonality by speed/RPM region
- **Dynamic start**
- **Pops & bangs** intensity (0–3 style levels)
- Presets
- Drive Select mapping (map OEM modes → sound profiles)
- Boombox one-shots (fun SFX — optional, not core)

---

## 4. Virtual gearbox (EV) — how they frame it

Problem they state:

> EVs are single-ratio / linear; pure pitch∝speed feels flat.

Solution they market:

> **Virtual gearbox** reconstructs gear-change *behavior* from driver inputs, not from a mechanical transmission.

Effects listed:

- Upshift during acceleration  
- Downshift under strong throttle / aggressiveness  
- Multiple downshifts on aggressive input  
- Rev-match color  
- Sound evolves with **style**, not only absolute speed  

**Discussion for our 3 vs 5 gears:**

THOR still sells **gear drama** on EV — so multi-gear active sound is industry-standard.  
But their goal is **emotion**, not correct real-world gear count at 120 km/h.  
For a **browser app** with shorter session + cabin-only playback, **3 gears** often clearer; THOR can afford denser shifts because layers + samples hide chatter better than pure synth.

---

## 5. Signal-flow mental model (reconstructed)

```
CAN / vehicle state
  ├─ speed (or wheel speed)
  ├─ throttle
  ├─ brake
  └─ (ICE: RPM)
        │
        ▼
  Virtual engine map
  ├─ virtual RPM (EV) or real RPM (ICE)
  ├─ virtual gear + shift events
  └─ load / dynamic (accel, lift-off)
        │
        ▼
  Multi-layer player (≤7 layers)
  ├─ idle bed
  ├─ body / load
  ├─ high rev / scream
  ├─ turbo / intake (profile-dependent)
  ├─ lift-off / overrun
  └─ pops & bangs (triggered)
        │
        ▼
  EQ / amp → STORM / THUNDER / ECHO cans
```

---

## 6. What makes THOR feel “real” (vs our current app)

| Factor | THOR | Tesla Active Sound (now) |
|--------|------|---------------------------|
| Content | Real recordings + TRS layers | Procedural pulse loops |
| Sync source | CAN throttle + speed (+ RPM) | GPS / sim speed + accel |
| Gear | Virtual gearbox (EV) | Speed-band gears |
| Output | Multi-speaker underbody | WebAudio → device speakers |
| Latency / consistency | Dedicated MCU | Browser + phone/car audio stack |
| Profiles | 30+ commercial packs | 15 synth profiles |

**Biggest realism gap is content (samples), not only gear count.**  
Control model (speed + throttle/accel + gears + lift-off) is the part we can copy well.

---

## 7. Implications for our product (discussion, not implementation)

### Keep / align with THOR philosophy

1. **Primary axes:** speed + **load (throttle/accel)** + **lift-off (decel)** — not speed alone  
2. **Virtual gears** for EV drama — but **fewer, longer bands** may sound better on weak synth  
3. **Explicit states:** idle · pull · cruise · overrun · shift flash  
4. **Layered mix:** body / high / intake / crackle as separate gains (like STORM/THUNDER/ECHO roles)  
5. **Profile = character pack** with per-region tuning (idle vs “working cycle”)  
6. Optional later: **sample banks** if we ever ship recorded layers  

### Do *not* need to copy

- Boombox gimmicks (unless wanted)  
- Cloud store / paid packs  
- Physical multi-can install  
- Full 7-layer commercial library  

### Gear count (ties to earlier discus)

- THOR: virtual multi-gear for *feel*  
- Us @ 0–120 map: **3 gears** = clearer ranges for procedural audio; **5** = denser like DCT marketing  
- Either is “valid”; choose by **audible clarity**, not by copying THOR’s count blindly  

---

## 8. Useful links

- Main: https://thor-tuning.com/us/thor/  
- Thor EV: https://thor-tuning.be/en/thor-ev.htm  
- Tesla landing: https://thor-tuning.com/us/tesla/  
- App (Play): `com.carsystems.thor.app`  
- App manual (PDF): https://thor-tuning.com/pdf/appinstruction.pdf  

---

## 9. One-paragraph summary

**THOR** is a CAN-synced multi-speaker active sound system that plays **multi-layer real-car recordings** (TRS), driven by **throttle + RPM** on ICE and by **speed + throttle + brake + virtual gearbox** on EV. Hardware splits low/mid/high (THUNDER / STORM / ECHO). The app exposes idle/cruise/pops/start tuning and large profile libraries. For our browser Tesla Active Sound, the high-value refs are: **load-driven layers, virtual gear drama, idle vs pull vs lift-off states** — not the underbody hardware or paid sample store.

---

*Saved as `docs/thor_ref.md` for project reference.*
