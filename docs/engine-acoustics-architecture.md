# Engine Acoustics Synthesis Platform — Engineering Specification

**Codename:** VESSEL (Virtual Engine Sound Synthesis & Emulation Layer)
**Doc owner:** Lead Engine Acoustics Research Engineer
**Status:** Design spec v0.1 — implementable from scratch
**Scope:** Real-time, synthesis-first internal-combustion engine sound. Samples are optional enhancement only.

---

## 0. The Core Principle — Engine Definition ≠ Sound Profile

The single most important architectural decision, and the one that unlocks studio-grade realism:

> **An engine *is* a fixed physical object. A recording is a *choice*.**
> The same LS7 sounds completely different at the tailpipe, in the cabin, in a tunnel, or filmed from a chase car. That difference is **not** the engine — it is the microphone, the room, and the mix.

Therefore the platform is split into **three fully decoupled stages** connected by a single well-defined interface (a mono, anechoic, reference-point pressure signal + a metadata sidechain of RPM/load/state):

```
┌─────────────────────────┐     ┌──────────────┐     ┌──────────────────────────┐
│   ENGINE DEFINITION      │     │  DSP ENGINE   │     │      SOUND PROFILE        │
│   (what the engine IS)   │ ──► │  (synthesis)  │ ──► │  (how it is CAPTURED)     │
├─────────────────────────┤     ├──────────────┤     ├──────────────────────────┤
│ Geometry                 │     │ crank-angle   │     │ EQ / tone shaping         │
│ Crank                    │     │ impulse core  │     │ Microphone (pos + type)   │
│ Firing order             │     │ waveguide     │     │ Environment (reflections) │
│ Cam / valvetrain         │     │ exhaust       │     │ Loudness / dynamics       │
│ Exhaust topology         │     │ resonators    │     │ Stereo / spatial          │
│ Intake                   │     │ harmonic bank │     │ Recording style           │
│ Combustion               │     │ mech-noise    │     │ Master limiter            │
│ Forced induction         │     │ transient FSM │     │                          │
└─────────────────────────┘     └──────────────┘     └──────────────────────────┘
     "the S85 V10"                 pure physics            "S85 in a tunnel, chase-cam"
```

**Interface contract (the seam):** the DSP Engine emits `enginePressure(t)` — a mono, dry, unreverberated signal that represents the acoustic pressure at a canonical reference point (defined as **0.5 m from the collector exit, on-axis, free field**). It also emits a `TelemetryFrame { rpm, load, throttle, gear, state, crankAngle }`. The Sound Profile consumes both. Nothing in Engine Definition knows a microphone exists; nothing in Sound Profile knows what a cylinder is.

**Consequences of the split**
- One engine definition → unlimited sound profiles (garage, cabin, drive-by, cinematic) with zero re-tuning of the engine.
- Community can share *engines* and *recording styles* independently.
- The engine model can be validated against real spectra objectively; the profile is subjective/artistic.
- Fixes the exact failure mode of the current Tesla Active Sound code, where "engine character," "EQ," and "cabin reverb" are tangled in one `tone{}` object and every tweak has side effects.

---

## 1. Layered Signal Architecture

```
CRANK CLOCK (angle-domain phase accumulator, sample-accurate)
      │  fires at scheduled crank angles per firing order + bank angle
      ▼
COMBUSTION EVENT BUS  ── per-cylinder pulses (pressure release), with
      │                    per-cylinder variance (imbalance, jitter, randomness)
      ├───────────────► INTAKE PATH  (ITB/plenum → airbox Helmholtz → intake radiation)
      │
      ▼
EXHAUST NETWORK  (per-cylinder primary waveguide → junctions 4-1/4-2-1/Tri-Y →
      │            collector → X/H cross-coupling → catalytic/resonator/muffler →
      │            tailpipe quarter-wave → exhaust radiation)
      │
      ├───────────────► MECHANICAL NOISE  (valve tick, timing chain, gear whine)
      ├───────────────► FORCED INDUCTION  (turbo/SC whine, wastegate, BOV, surge, anti-lag)
      │
      ▼
HARMONIC / SPECTRAL LAYER  (dynamic harmonic bank + formants + spectral morph vs RPM)
      │
      ▼
TRANSIENT FSM  (idle-hunt, tip-in, lift-off, rev-hang, rev-drop, fuel-cut, overrun, backfire)
      │
      ▼
=== enginePressure(t) + TelemetryFrame  ============ [ THE SEAM ] ==============
      │
      ▼
SOUND PROFILE:  EQ → Mic model → Environment (early reflections + tunnel/cabin) →
                Distance/ground → Stereo imaging → Loudness/dynamics → Master limiter
      │
      ▼
OUTPUT (stereo / binaural / multichannel)
```

Everything above the seam is **angle-synchronous** (driven by crank angle, so pitch and pulse timing are inherently correct at any RPM and during transients). Everything below the seam is **time-synchronous** (ordinary DSP at the output sample rate).

---

## 2. The Physical Synthesis Core (why this is *not* an EQ or sample player)

### 2.1 Crank-angle clock
A phase accumulator advances in **degrees of crank rotation**, not seconds:
```
crankDeg += (rpm / 60) * 360 * dt      // dt = 1/sampleRate
crankDeg = crankDeg mod 720            // 4-stroke = 720° cycle
```
Because everything is scheduled in this domain, pitch tracks RPM *for free*, and rev-up/down, rev-hang and idle-hunt are just modulations of `rpm` — no repitching artifacts, no sample stretching. This is the foundation of "synthesis-first."

### 2.2 Combustion event → pressure pulse
Each cylinder fires **once per 720°** at a crank angle set by the firing order. At its event, inject an excitation pulse into that cylinder's exhaust-port waveguide. Pulse model (parametric, cheap):
```
pulse(τ) = A · (1 - e^(−τ/attack)) · e^(−τ/decay) · shaped(sharpness)
```
- `attack` ~0.2–1 ms (valve opening), `decay` = pulse_decay, `sharpness` warps the curve toward a crack (race) or a soft thud (muffled cruiser).
- `A` (amplitude) scales with load × a combustion-efficiency curve.

### 2.3 The crank type is the soul of the engine (pure geometry, no EQ)
The **angular spacing** of the pulse train is what your ear recognizes as "V8 vs flat-plane vs boxer." Set by crank type + bank angle + firing order:

| Crank / config | Pulse spacing | Result | Engines |
|---|---|---|---|
| Cross-plane V8 (90° bank, 90° crank) | Uneven per-bank (grouped), banks interleave to 90/180 lope | The American "potato" burble & offbeat rumble | LS, Coyote, HEMI, NASCAR |
| Flat-plane V8 (90° bank, 180° crank) | Perfectly even 90° | Screaming, smooth, high-order — "half a V12" | Ferrari 458/F355, Voodoo GT350 |
| V12 (60°) | Even 60° | Silky, dense harmonics, "tearing silk" | Ferrari, Lambo, F1 V12, LFA (V10 close) |
| V10 (72° or 90°) | Even-ish, unique 5-per-bank | The F1/Lambo/LFA wail | S85, Lambo, F1 V10 |
| Flat-6 boxer (180°) | Even but two opposed banks | Warble/"boxer rumble" | Porsche, EJ20/FA24 (unequal headers add the Subaru burble) |
| Inline-4 (180°) | Even 180° | Buzzy, 2nd-order dominant | K20, F20C, 4A-GE, most bikes |
| Inline-6 (120°) | Even 120° | Smooth, "straight-six creamy" | RB26, 2JZ, B58, S54/S58 |
| Rotary (no pistons) | 3 combustion events / eccentric-shaft rev per rotor | The "brap" — high, buzzy, no reciprocating lope | 13B, 20B |
| Crossplane inline-4 (bike) | Uneven 90° | R1 "V4-like" growl | Yamaha CP4 |
| V-twin (big angle) | Very uneven (potato-potato) | Harley lope | Cruiser V-twins |

**This table is implemented entirely by scheduling pulse angles + amplitude variance — no sample, no EQ.** The remaining timbre is shaped physically by the exhaust/intake below.

### 2.4 Exhaust as a digital waveguide network
Each primary pipe = a bidirectional delay line (waveguide); junctions = scattering nodes (impedance mismatch → partial reflection/transmission). This reproduces, *physically*:
- **Header length / equal vs unequal** → pulse arrival phase at the collector → constructive/destructive comb interference → the "which header" tonal signature. Unequal-length + boxer 180° crank = the famous Subaru burble (interference beating).
- **4-1 vs 4-2-1 vs Tri-Y** = different junction topologies = different resonance/scavenging comb patterns (low-end torque tone vs top-end scream).
- **Collector, X-pipe, H-pipe** = merge + cross-bank coupling → changes even/odd harmonic ratio (X-pipe "smooths," H-pipe keeps bank identity).
- **Cat / resonator / muffler / glasspack** = chambered lowpass + tuned notches (quarter-wave/Helmholtz). Straight-pipe = minimal filtering = loud & raw.
- **Tailpipe length/diameter** = final quarter-wave resonance (the "note").

Implementation: fixed-topology scattering network with per-segment delay lengths derived from physical length ÷ speed of sound (with a temperature term). ~1–3 delay lines per bank + a handful of one-pole/biquad junction filters. Cheap, and *correct*.

### 2.5 Intake path
ITBs + velocity stacks + airbox = Helmholtz/quarter-wave resonators feeding a separate **intake radiation** point. The "ITB honk/roar" (F1, S2000, MotoGP, individual-throttle race engines) is intake resonance being loud and open near its tuned RPM. Modeled as a resonant bandpass whose center tracks intake tuned length and whose gain rises with throttle.

### 2.6 Harmonic / spectral layer (the hybrid boost)
On top of the physical model, a **dynamic harmonic bank** (8+ partials, each with its own gain-vs-RPM curve) plus fixed **formant** filters give exact timbral control and let you dial *spectral morphing* — how the harmonic balance opens up with revs (Ferrari V12 brightening on top, the LFA "angel scream"). This is where a real recording's fingerprint is matched, and it's the layer the Tuning Bench should expose most.

### 2.7 Mechanical, forced-induction, and transient layers
- **Mechanical noise:** valve tick (impulses at cam frequency = rpm/2 events), timing chain/gear whine (tonal, tracks rpm), injector clicks. Angle-synchronous filtered noise bursts.
- **Forced induction:** *turbo* whine = tonal partial tracking shaft speed (∝ boost, first-order lag behind rpm); *supercharger* whine = tonal, tracks rpm **directly** (belt-driven, no lag — the Hellcat/GT500 signature); wastegate/BOV = noise bursts on lift; compressor surge = amplitude-modulated whistle; **anti-lag** = scheduled fuel-in-exhaust detonations = rapid randomized crack bursts on overrun (WRC signature).
- **Transient FSM:** idle-hunting (small rpm LFO), throttle tip-in (load lead), lift-off, engine braking (overrun band + decel), **rev-hang** (rpm decays slowly off-throttle — drive-by-wire trait), rev-drop (fast), fuel-cut on limiter (chop), overrun/backfire (unburnt-fuel pops).

---

## 3. Module & Parameter Catalog

Format per parameter: **Physical meaning · DSP implementation · Audible effect · Range · Interactions · Key engines · UI tier** (B=Beginner, A=Advanced, D=Developer, R=Research). To keep this navigable, catalogs are tabular; architecturally pivotal parameters get prose.

### 3.1 ENGINE DEFINITION — Geometry
| Param | Physical | DSP | Audible | Range | Engines | UI |
|---|---|---|---|---|---|---|
| `cylinders` | count | # of pulse generators | density of pulses | 1–16 | all | B |
| `bank_angle` | V-angle | phase offset between banks | evenness/lope | 0–180° | V-engines | A |
| `crank_type` | crank throw layout | pulse-angle schedule | THE character (§2.3) | enum | all | B |
| `firing_order` | ignition sequence | pulse ordering | subtle beat/rumble phase | perm | all | D |
| `combustion_timing` | spark advance | pulse sub-angle shift | edge/aggression | ±20° | all | R |
| `compression_ratio` | CR | pulse sharpness+brightness | crispness | 8–14 | all | R |
| `cyl_imbalance` | per-cyl variance | per-pulse amp/timing jitter | "alive," lope | 0–1 | classics/race | A |

Crank type + bank angle + firing order together are the "geometry fingerprint" — get these right and a listener already names the engine family before any EQ.

### 3.2 Valvetrain
| Param | Physical | DSP | Audible | Range | Engines | UI |
|---|---|---|---|---|---|---|
| `cam_duration` | how long valves open | pulse width + overlap window | lumpy idle → smooth | 0–1 | cams/race | A |
| `valve_lift` | lift height | pulse amplitude/brightness | breathing/openness | 0–1 | all | A |
| `valve_overlap` | intake+exhaust both open | cross-injection intake↔exhaust + idle instability | the **cammed lope**, reversion chop | 0–1 | muscle/race | A |
| `vvt` (variable timing) | cam phaser | RPM-scheduled overlap shift | tone shift across RPM | curve | modern | A |
| `vvl` (VTEC/lift) | 2nd cam profile | step change in width/brightness at `cam_switch_rpm` | the **VTEC crossover** | rpm | K20/F20C | B |

### 3.3 Intake
| Param | Physical | DSP | Audible | Range | Engines | UI |
|---|---|---|---|---|---|---|
| `throttle_type` | ITB vs single | intake resonance sharpness | honk vs muted | enum | race/JDM | A |
| `velocity_stack_len` | runner length | intake tuned freq | resonance pitch | mm | ITB engines | R |
| `airbox_volume` | plenum size | Helmholtz freq/Q | intake boom | L | all | R |
| `intake_resonance` | net intake Q | resonant bandpass gain | ITB roar | 0–1 | F1/S2000 | A |
| `intake_noise` | turbulence | filtered noise ∝ throttle | "air" | 0–1 | all | A |

### 3.4 Exhaust (topology + tuning) — see §2.4
| Param | Physical | DSP | Audible | Range | Engines | UI |
|---|---|---|---|---|---|---|
| `header_type` | 4-1 / 4-2-1 / Tri-Y / 180 | junction network | tonal signature | enum | all | A |
| `header_len_primary` | primary length | waveguide delay | pitch of scavenge note | mm | all | R |
| `header_equal_length` | equal vs unequal | delay match/mismatch | Subaru burble when unequal | bool | boxers | A |
| `collector` | merge point | scattering node | fullness | — | all | D |
| `x_pipe`/`h_pipe` | cross-coupling | inter-bank mix filter | smooth vs raw bank ID | enum | V8/V6 | A |
| `cat`/`resonator` | absorptive chambers | LP + notch | droning/quiet | 0–1 | street | A |
| `muffler_type` | chambered/straight/glasspack | filter bank | loud/raw ↔ refined | enum | all | B |
| `tailpipe_len`/`dia` | final tube | quarter-wave resonance | the "note" | mm | all | R |

### 3.5 Exhaust Pulse Generator (the excitation)
| Param | Physical | DSP | Audible | Range | UI |
|---|---|---|---|---|---|
| `pulse_width` | port-open duration | excitation width | fat vs sharp | 0–1 | A |
| `pulse_decay` | pressure decay | envelope tail | ring vs dead | 0–1 | A |
| `pulse_sharpness` | wavefront steepness | high-freq content | crack vs thud | 0–1 | A |
| `pulse_timing` | event phase | schedule offset | groove/beat | ±° | D |
| `pulse_interference` | header phase mix | comb-filter depth | hollowness | 0–1 | D |

### 3.6 Mechanical Noise / Forced Induction / Combustion Randomness / Transients
Compact — all documented per §2.7. Selected pivotal ones:

| Param | Physical | DSP | Audible | Engines | UI |
|---|---|---|---|---|---|
| `supercharger_whine` | belt blower tone | osc tracks **rpm** (no lag) | Hellcat/GT500/Voodoo-SC whine | SC engines | B |
| `turbo_whistle` | compressor tone | osc tracks **boost** (lagged) | spool whistle | turbo | B |
| `wastegate`/`bov` | pressure release | noise burst on lift | psshh/flutter | turbo | A |
| `compressor_surge` | stall | AM whistle | flutter/chatter | turbo | A |
| `anti_lag` | fuel in exhaust | randomized crack bursts on overrun | WRC bang-bang | rally | A |
| `overrun`/`backfire` | unburnt fuel pops | gated pop generator on decel | crackle/pop | many | B |
| `ignition_jitter` | spark timing noise | ±° per-event jitter | realism/roughness | classics | R |
| `combustion_randomness` | cycle-to-cycle | amp/time noise per pulse | "alive" not looped | all | A |
| `rev_hang` | DBW off-throttle | slow rpm decay | modern lift feel | modern | A |
| `idle_hunting` | idle governor | small rpm LFO | living idle | all | A |

### 3.7 Dynamic Harmonic Generator (§2.6)
`harmonic[1..8].gain` + `harmonic[n].rpm_curve`. Fundamental tracks the dominant firing order (e.g., V8 cross-plane fundamental ≈ rpm/60 × 4). Higher partials with rising RPM curves = the "opening up" of exotics. **Advanced/Research** UI (Beginner sees a single "Brightness/Character" macro that maps to the bank).

### 3.8 SOUND PROFILE — Environmental Acoustics (below the seam)
| Param | Physical | DSP | Audible | UI |
|---|---|---|---|---|
| `mic_position` | tailpipe/cabin/chase/onboard | pre-delay + response preset | perspective | B |
| `mic_type` | dynamic/condenser/ribbon | freq-response EQ curve | tonal color | A |
| `cabin_resonance` | interior transfer fn | modal filter bank + short RT | "inside the car" | B |
| `tunnel_reflection` | slap-back walls | delayed reflections + long RT | tunnel roar | A |
| `wall_reflection` | early reflections | tapped delays | space | A |
| `ground_reflection` | comb from ground | fixed short comb | outdoor realism | R |
| `distance_delay` | propagation | delay + LP (air absorption) | far vs near | A |
| `recording_style` | dry/cinematic/onboard | macro over the above | vibe | B |
| `stereo_width` | image | mid/side or HRTF | narrow↔wide/binaural | A |
| `loudness_curve` | SPL vs load | dynamic gain (dB model) | quiet cruise ↔ WOT | B |

---

## 4. GUI Modes

| Mode | Audience | Exposes | Hides |
|---|---|---|---|
| **Beginner** | end user | Preset picker, 1 Character macro, Volume, Recording-Style picker, forced-induction on/off | everything physical |
| **Advanced** | enthusiast tuner | full harmonic bank, exhaust/intake/cam macros, mic + environment, transient feel | raw waveguide lengths, per-event jitter |
| **Developer** | profile author | all Engine Definition params incl. firing order, header lengths, pulse timing, command console, A/B snapshots (OK1–5), Dump | research-grade internals |
| **Research** | acoustician | per-cylinder variance, scattering-node coefficients, spectral-morph editor, live spectrogram vs reference, ignition/combustion stochastics, unit-level probes | nothing |

Every mode reads the **same** parameter space; modes are just *views* (visibility masks + macro mappings). A Beginner "Character" macro is a stored curve that drives ~8 advanced params; promoting to Advanced simply unlocks them at their macro-resolved values.

---

## 5. Preset Engine

A preset is **pure parameter values** — no audio, ever. Two independent preset namespaces because of the §0 split:
- **Engine presets** (`.engine`): only Engine-Definition params.
- **Profile presets** (`.profile`): only Sound-Profile params.
- **Combos** (`.rig`): a named pairing `{engine, profile}` + metadata.

Presets support **inheritance** (`inherits`), **partial overrides**, and are the *only* thing shipped/shared. Runtime resolves preset → parameter vector → DSP graph configuration.

---

## 6. Signature Profiles (parameter-only, illustrative)

Each is a point in parameter space. Examples (abbreviated — Advanced fields shown):

```
LS7        crank=crossplane bank=90 header=long_tube_4-1 x_pipe=on
           pulse_width=.62 pulse_decay=.40 muffler=street lope=.30
           harmonic{1:1,2:.9,3:.5,4:.6} rpm_redline=7000
Voodoo     crank=FLATPLANE bank=90 header=equal_4-1 muffler=straight
           harmonic{high rising} scream=high rpm_redline=8250   # "American Ferrari"
Hellcat    crank=crossplane supercharger_whine=.8(no-lag) header=4-1
           muffler=street sub=high rpm_redline=6200
Ferrari458 crank=FLATPLANE bank=90 header=equal muffler=sport
           harmonic{2:.4,3:.75,5:.5,7:.35 rising} intake_resonance=.6 rpm_redline=9000
FerrariV12 crank=v12 bank=60 harmonic{dense,silky} intake_resonance=.5 rpm_redline=8500
LFA        crank=v10 bank=72 intake_resonance=.9(ITB) harmonic{angelic high} rpm_redline=9000
PorscheGT3 crank=flat6 bank=180 header=unequal? no→equal metallic=.5 rpm_redline=9000
RB26       crank=i6 bank=0 turbo_whistle=.9 header=4-1 rpm_redline=8000
2JZ        crank=i6 turbo_whistle=.85 sub=high rpm_redline=7000
13B        crank=ROTARY events=3/rev/rotor buzz=high rpm_redline=8500
20B        crank=ROTARY rotors=3 richer rpm_redline=8000
MotoGP     crank=i4/crossplane intake_resonance=1 rpm_redline=18000 screamer
F1_V10     crank=v10 bank=90 intake_resonance=1 harmonic{extreme high} rpm_redline=18000
F1_V12     crank=v12 harmonic{tearing} rpm_redline=15000
NASCAR     crank=crossplane V8 header=long muffler=none rpm_redline=9000 raw
```

---

## 7. Command Language — **EDL** (Engine Definition Language)

The naive `key=value / IMPORT` example works but doesn't scale. EDL is designed to be **human-readable and trivially emittable by any LLM** (ChatGPT/Claude/Gemini/Grok) while supporting comments, metadata, inheritance, partial updates, versioning, validation, ranges, units, expressions, macros, aliases.

### 7.1 Design goals
- Declarative, line-oriented, whitespace-insensitive, UTF-8.
- Superset-friendly: valid EDL is also valid enough to round-trip to JSON/YAML/TOML.
- **LLM-safe:** no ambiguous punctuation, block keywords are ALL-CAPS, one statement per line, `#` comments.

### 7.2 Grammar (EBNF, abridged)
```
document   = { statement } ;
statement  = block | assignment | directive | comment ;
block      = ("ENGINE"|"PROFILE"|"RIG"|"MACRO"|"META") name [ "INHERITS" name {"," name} ] NEWLINE
             { assignment | comment } "END" ;
assignment = key [index] "=" expr [ unit ] [ "@" rpm_curve ] ;
directive  = "IMPORT" | "VALIDATE" | "APPLY" partial | "VERSION" semver | "USE" alias ;
expr       = number | string | enum | bool | macro_call | arithmetic ;
rpm_curve  = "{" { rpm ":" number } "}" ;    # per-RPM breakpoints
unit       = "mm"|"cm"|"L"|"deg"|"hz"|"rpm"|"db"|"%"|"ms" ;
```

### 7.3 Feature demonstration
```edl
# --- LS7, long-tube, X-pipe, street muffler ---------------------------
META
  name        = "LS7 Street"
  author      = "@markchsr"
  version     = 1.2.0
  target      = "Chevrolet LS7 7.0 V8"
  compat      = ">=vessel-0.1"
END

ENGINE LS7 INHERITS V8_CROSSPLANE      # inheritance
  bank_angle       = 90 deg
  firing_order     = [1,8,7,2,6,5,4,3]
  cam_overlap      = 0.42
  valve_lift       = 0.71
  header           = long_tube_4-1     # enum alias
  header_len_prim  = 800 mm            # unit → internal seconds via c(T)
  x_pipe           = on
  pulse_width      = 0.63
  pulse_decay      = 0.38
  muffler          = straight_pipe
  rpm_idle         = 780 rpm
  rpm_redline      = 7000 rpm
  harmonic[3]      = 0.74 @ {2000:0.4, 5000:0.8, 7000:0.95}   # rising 3rd
  harmonic[5]      = 0.42
  metallic         = clamp(0.3 + 0.2*cam_overlap, 0, 1)       # expression
END

# partial update layered on top (does NOT redefine the whole engine)
APPLY LS7
  muffler   = glasspack
  rpm_redline = 7200 rpm
END

VALIDATE            # range-checks every field, reports out-of-range
IMPORT              # commit to the running DSP graph
```

### 7.4 Semantics
- **Inheritance** resolves depth-first, later wins; cycles rejected at VALIDATE.
- **Macros** (`MACRO`) expand to param sets; **aliases** (`USE`) rename enums/keys for readability.
- **Expressions** are a sandboxed pure-numeric mini-language (`+ - * / min max clamp lerp sin`), referencing already-assigned keys.
- **Ranges/validation:** every key has a schema `{min,max,unit,tier,default}`; `VALIDATE` is non-destructive, `IMPORT` requires a clean validate (or `IMPORT FORCE`).
- **Partial updates** (`APPLY`) mutate only listed keys — ideal for iterative LLM tuning ("make the 3rd harmonic hotter above 5k").
- **Versioning:** `version` (semver) + `compat` range; loader migrates older schemas via registered upgraders.
- **Unit conversion:** physical units convert to internal representation at parse (e.g., `mm` → delay samples via temperature-dependent speed of sound).

---

## 8. Serialization Formats

The parameter vector is format-agnostic; EDL is the *authoring* surface, the rest are *interchange*.

**JSON** (canonical machine form, the one the runtime loads):
```json
{ "schema":"vessel/1", "kind":"engine", "meta":{"name":"LS7 Street","author":"@markchsr","version":"1.2.0","target":"LS7 V8"},
  "inherits":["V8_CROSSPLANE"],
  "engine":{ "bank_angle":90,"crank_type":"crossplane","firing_order":[1,8,7,2,6,5,4,3],
             "cam_overlap":0.42,"header":"long_tube_4-1","header_len_prim_mm":800,"x_pipe":true,
             "pulse_width":0.63,"pulse_decay":0.38,"muffler":"straight_pipe",
             "rpm_idle":780,"rpm_redline":7000,
             "harmonics":{"3":{"base":0.74,"curve":{"2000":0.4,"5000":0.8,"7000":0.95}},"5":{"base":0.42}} } }
```
**YAML** (human diff-friendly, PR reviews), **TOML** (config-file ergonomics) — both are 1:1 projections of the JSON schema; a single schema definition generates all three codecs.

**Binary** (`.vsl`): little-endian, `MAGIC "VSL1"` + `u16 schemaVer` + `u16 count` + packed `{keyId:u16, type:u8, value}` records; keyIds from a stable registry; ~0.5–2 KB/preset; used for fast bundling of 500+ presets and OTA. Deterministic, hashable for integrity.

---

## 9. Profile Sharing System

Exportable package (`.vesselpack`, a small zip or single JSON) with a metadata block:
```
name, author, description, version, license, compat (engine schema range),
target_engine, kind (engine|profile|rig),
recommended_speakers, recommended_headphones, recommended_samplerate,
tags[], reference_clip_url (optional, NOT bundled), preview_spectrogram (optional png),
checksum, created, updated
```
Sharing rules mirror §0: you can publish an **engine**, a **recording profile**, or a **rig** (pairing) independently. No audio samples are ever required or bundled; optional enhancement samples, if any, are referenced by URL with license, never embedded.

---

## 10. Architecture Review

### 10.1 Strengths
- The §0 split is the decisive win: objective engine models + subjective profiles, independently shareable and testable.
- Angle-domain core makes pitch/transients physically correct with no repitching artifacts.
- Physical exhaust/intake modeling reproduces "which header/crank" signatures that EQ-only or sample systems cannot fake convincingly.
- Parameter-only presets → tiny, diffable, LLM-authorable, infinitely combinable.

### 10.2 Weaknesses / risks
- **Waveguide stability & tuning:** scattering networks can ring or go unstable with bad coefficients; needs a validated coefficient solver and guard-rails.
- **Parameter explosion:** ~100 params × interactions → combinatorial tuning burden. Mitigate with macros + a reference-matching workflow (fit params to a target spectrum).
- **Aliasing:** sharp pulse trains at high RPM (18k redline bikes/F1) generate high harmonics → must band-limit (BLIT/polyBLEP-style pulse generation, or oversample the core 2–4×).
- **CPU on mobile / Tesla browser:** the physical core is heavier than the current additive engine.
- **Authenticity ceiling without samples:** synthesis gets ~85–95% for most engines; the last few % of "recording magic" still favors optional sample layers.

### 10.3 Predicted bottlenecks & scaling to 500+ profiles
- Profiles are just data (~1–2 KB each) → **500 profiles ≈ <1 MB**; a 5000-profile library is trivial in storage. No per-profile audio = no asset bloat (the killer problem of sample systems).
- Only ONE engine is ever *instantiated* at a time (the selected one) → runtime cost is independent of library size. Switching = re-solve the graph (a few ms).
- The registry/index (search, tags, compat) is the only thing that grows; keep it as a flat JSON index + optional SQLite for 10k+.

### 10.4 Resource estimates (per active engine, 48 kHz, stereo)
- **CPU:** core (crank clock + ≤16 pulse gens + 3–6 waveguide segments + junction filters + 8-partial harmonic bank + noise) ≈ **3–8% of one modern desktop core**; Sound Profile (EQ + reflections + reverb + limiter) ≈ **2–5%**. Mobile/Tesla-browser target: run core at 1× with polyBLEP (no oversample) → aim ≤ **15–20% of one core**; provide a "lite" graph (fewer waveguide segments, additive fallback) for MCU2-class hardware.
- **Memory:** engine graph + buffers ≈ **200–600 KB** live; delay lines dominate (tailpipe/header lengths). Whole preset library (500) < 1 MB. No sample RAM.
- **Latency:** WebAudio at 128-sample quantum ≈ **~3 ms** algorithmic; total glass-to-ear driven by the platform (~10–30 ms). The angle-domain design adds no lookahead.
- **Maintainability:** high — schema-driven params, one source of truth generating all codecs + UI + validation. Each DSP module is independently unit-testable against a reference spectrum.
- **Extensibility:** high — new engine families = new crank/firing schedules + a preset; new capture styles = new Sound-Profile modules; both additive, no core rewrite. `schema` versioning + upgraders protect old presets.

### 10.5 Recommended build order
1. Seam + telemetry contract, then the crank-angle core + pulse generator (validate V8 cross vs flat-plane by ear — proves the thesis).
2. Waveguide exhaust (header topology) + harmonic bank.
3. Sound-Profile stage (mic/environment/loudness) — reuse/upgrade the current DynamicVolume + zone + limiter work already in the Tesla app.
4. EDL parser + JSON schema + Tuning Bench bound to the new param space (evolve the existing `_eval/tune.html`).
5. Preset library + sharing + the other codecs (YAML/TOML/binary).

### 10.6 Migration from the current Tesla Active Sound codebase
The existing app already has, in embryonic form: an additive layer engine, a 50 Hz decoupled update loop, load-driven DynamicVolume (a dB loudness model), front/rear spatial zones, a brick-wall limiter, and a live Tuning Bench. Map them onto VESSEL:
- Current `tone{}` → **split** into `engine{}` (character) and `profile{}` (EQ/mic/env/loudness) — this *is* the §0 refactor and immediately fixes the "every tweak has side effects" problem the user hit.
- DynamicVolume + zones + limiter → move **below the seam** into the Sound Profile unchanged.
- `gearbox.js` / RPM model → stays as a *consumer* of telemetry driving `rpm`; the crank-angle core replaces the buffer-playback synthesis over time (phased: additive stays as the "lite" fallback graph).

---

*This document is the north star for reimplementing the audio engine as a professional engine-acoustics workstation. It is intentionally not simplified.*
