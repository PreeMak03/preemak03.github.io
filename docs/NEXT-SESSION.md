# Where the judder stands — 2026-08-23

Everything below is measured, not remembered. Live build: **tas-v101**.

## The one thing to do first

**Drive it and send a trace.** Nothing else in this file is worth acting on until
that happens, because the last round of fixes has never been heard in the car.

When the trace arrives, read these three fields FIRST:

| field | what it settles |
|---|---|
| `rig.build` | which code actually ran — the last five traces said `null` (my bug, fixed) |
| `engineStarts` | 1 is normal. More means the engine restarted mid-drive |
| `inputs[]` | every key/wheel event seen, and `[in a text field]` / `[not in manual]` when one was dropped |

**Dedupe traces before analysing.** The last five files were ONE drive sent five
times — identical events at identical timestamps. Pooling them counted the same
evidence four times (6,671 samples → 2,865 real). Key on `t|rpm|v`.

## What the judder actually is

From the deduplicated traces, self-restarts excluded:

- **5.4% of drive time** is above 6 dB of level swing. Not continuous — about
  13 brief episodes of 0.02–0.6 s over ten minutes.
- Overall p50 1.9, p90 5.0, p99 8.3, max 11.8.

| cause | share of loud events | state |
|---|---|---|
| high speed / post-gear-change | **57%** | fixed in 04e626a, untested in the car |
| low-speed crawl (≤25 km/h) | 32% | cause partly known, NOT fixed |
| the rest | 11% | unexamined |

## Fixed and awaiting a drive test

- **Shift landing eased out** (04e626a). Pinning the rev target at the landing
  value and dropping the pin in one tick left a corner; smoothstep removes it.
  Release-window jerk 606 → 35, measured by stashing the real code both ways.
- **Manual shift inputs restored** (04e626a). `isTyping` matched any INPUT, and
  the sim speed control is `<input type="range">`, so with it focused every gear
  input was dropped in silence. This is what made him restart the engine
  mid-drive, which produced the loudest artefact in the traces.

## The open one: low-speed crawl, 32%

0-10 km/h reads p50 3.2 against 1.2 at 45-70 km/h. Cause still unknown.

### DEAD END, properly measured — do not retry rev wander

`wanderRpm` is an ABSOLUTE count while pitch is logarithmic, so the same 56 rpm
is 0.86 of a semitone at 1140 and 0.48 at 1907. It was sized against classic at
60 km/h and never checked elsewhere, so scaling it by rpm/1900 looked like an
obvious correction.

**It measures WORSE.** Three renders per point, spreads in brackets:

| km/h | before p90 | after p90 |
|---|---|---|
| 8 | 2.15 (0.06) | **2.65 (0.13)** |
| 18 | 1.73 (0.45) | 1.64 (0.47) |
| 60 | 1.50 (0.48) | 1.55 (0.23) |

At 8 km/h that is half a dB worse against a spread of 0.13 — well clear of the
noise, not a coin toss. 18 and 60 are both inside their spreads.

The reason is the owner's own observation: *"ถ้าปล่อย rpm breath มันก็จะไม่
pattern"*. **Wander is what smears the wavetable's periodicity.** Steadying the
pitch makes the repeating waveform MORE coherent, so the measured roughness
rises. It is doing useful work down there, and the single-run measurement that
started this ("wander off → p90 0.74") was noise.

So the low-speed roughness is NOT the wander. Look elsewhere: at 8 km/h half a
km/h of GPS noise is 6% of the reading against 0.8% at 60, so the derived
acceleration is noisiest exactly where the roughness is worst — but
`accelSmoothMul: 0.2` was already live for the traced drive and did not settle
it, so that is not the whole answer either.

## Tools

- `offlineBench.compare(id, tweakFn)` — before/after on the real graph, offline.
  **Read `verdict`, never `deltaDb`**: the engine breathes on Math.random().
- `offlineBench.attack(id)` — how fast the voice arrives, in fixed dB steps.
- `offlineBench.loopiness(buf, rpm)` on the `hold` script.
- `revStep` in every `run()` — biggest one-tick jump in the rev line. Past ~2
  semitones something is ASSIGNING the revs instead of steering them.
- `/vessel/tools/loop-lab.html` — hold a rev, dial engine and noise 0-150%.

## Hazard

`js/vessel-audio.js` and `js/vessel-runtime.worklet.js` carry uncommitted,
never-drive-tested VESSEL work. They are in the lab-serve ship list. Check
`git status` before any CommandRoom deploy.
