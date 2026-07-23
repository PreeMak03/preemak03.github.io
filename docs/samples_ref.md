# Free / Open Engine Sound Samples — Catalog

> Companion to `thor_ref.md`. THOR uses multi-layer **real recordings**.  
> This file lists **legally usable free/open** sources we can build sample packs from.  
> Always re-check the license on the download page before shipping.

---

## How THOR-style packs should be structured

Ideal pack (mirrors THOR multi-layer idea):

```
assets/samples/<pack-id>/
  manifest.json
  idle_loop.ogg|wav          # bed at idle / low load
  body_loop.ogg|wav          # mid exhaust body (STORM-like)
  high_loop.ogg|wav          # high rev / scream (ECHO-like)
  load_loop.ogg|wav          # optional: heavy throttle layer
  overrun_loop.ogg|wav       # optional: lift-off
  crackle_oneshot.ogg|wav    # optional: short pop
  ATTRIBUTION.txt
```

**Playback model (THOR-like):**
- `playbackRate` ∝ virtual RPM  
- layer **gains** ∝ state (idle / pull / cruise / overrun) + load  
- crossfade layers, never hard-cut  
- shift event = short gain dip + optional click + RPM drop  

If a pack is incomplete → engine **falls back to procedural** layers for missing slots.

---

## Best free sources (practical)

### 1. Freesound.org (primary mine)
- Search: `car engine loop`, `exhaust`, `idle`, `motorcycle engine`  
- Filter: **CC0** (safest) or **CC-BY** (credit required)  
- Avoid CC-BY-NC for commercial / unclear redistribution  

**Useful starting points:**
| Link / query | Notes |
|--------------|--------|
| https://freesound.org/search/?q=car+engine+loop | Many loops; check license per file |
| https://freesound.org/browse/tags/motor/ | Motors / engines tag |
| Sedan engine loop (example) https://freesound.org/people/Dmitry_mansurev64/sounds/748027/ | Game/anim loop — verify license on page |
| https://freesound.org/people/alec_havinmaa/sounds/443269/ | Mentioned as seamless loop in forums |

**Workflow:** download → normalize loudness → trim seamless loop → put in pack folder → list in `ATTRIBUTION.txt`.

### 2. Pixabay Sound Effects
- https://pixabay.com/sound-effects/search/car-engine/  
- Large library, **royalty-free** under Pixabay Content License  
- Good for one-shots / ambient; quality varies  
- Read: https://pixabay.com/service/license-summary/

### 3. OpenGameArt
- https://opengameart.org/  
- Search: `engine`, `vehicle`, `car`  
- Licenses mix CC0 / CC-BY / OGA-BY — credit when required  
- Often game-ready loops (short)

### 4. Kenney.nl
- https://kenney.nl/assets  
- Many **CC0** game asset packs  
- Engine/vehicle SFX exist in some packs but **not full multi-layer exhaust libraries**  
- Great for UI / click / shift blip fillers

### 5. ZapSplat / Mixkit (free tiers)
- https://www.zapsplat.com/  
- https://mixkit.co/free-sound-effects/  
- Free accounts / free tiers often OK for personal/dev  
- **Read commercial terms carefully** before shipping as a product

### 6. GitHub / game open sources
Search periodically:
```
github car engine sound wav
github vehicle sfx cc0
```
Quality and license vary; always copy the LICENSE file into the pack.

---

## What we still lack in free sources

| Need (THOR-like) | Free availability |
|------------------|-------------------|
| Idle seamless loop | **Common** (CC0/CC-BY) |
| Steady cruise body loop | **Common** |
| High-RPM scream layer | **Medium** (often motorcycle / race) |
| Load-only layer (throttle open) | **Rare** as separate file |
| Lift-off / overrun crackle set | **Medium** (one-shots) |
| Full multi-RPM multi-sample bank (like commercial) | **Rare free** |

Honest expectation: free packs get us **~40–70%** of THOR “realness”.  
Commercial sample libs or custom recording close the rest.

---

## Suggested first free pack plan (manual download)

Create pack `assets/samples/free-sedan/`:

1. 1× idle loop (CC0)  
2. 1× mid body loop (CC0)  
3. 1× higher / aggressive loop (CC0 or motorcycle if needed)  
4. 1–3× short crackle/pop one-shots  
5. `ATTRIBUTION.txt` with author + URL + license  

Then set profile `samplePack: "free-sedan"` in `profiles.js`.

---

## License checklist (before commit)

- [ ] License is CC0 / CC-BY / Pixabay / explicit free  
- [ ] Attribution file present if not CC0  
- [ ] No “personal use only” / NC-only if we need commercial  
- [ ] Loop is seamless (or crossfaded in engine)  
- [ ] Peak normalized (~-3 to -6 dBFS) so packs mix evenly  

---

## Legal note

This catalog is research only.  
**Do not assume** a search result is free until the file’s page license is verified.  
THOR’s own commercial packs are **not** free and must **not** be ripped.

---

*Last updated for Tesla Active Sound sample pipeline.*
