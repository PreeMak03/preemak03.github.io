# Sample packs (THOR-style layers)

Drop free/open loops here. Engine loads packs at runtime.

```
assets/samples/<pack-id>/
  manifest.json
  idle.ogg          (or .wav)
  body.ogg
  high.ogg
  load.ogg          optional
  overrun.ogg       optional
  crackle.ogg       optional oneshot
  ATTRIBUTION.txt
```

See `docs/samples_ref.md` for free sources and `docs/thor_ref.md` for control model.

## manifest.json example

```json
{
  "id": "free-sedan",
  "name": "Free Sedan",
  "license": "CC0",
  "refRpm": 4000,
  "layers": {
    "idle": "idle.ogg",
    "body": "body.ogg",
    "high": "high.ogg",
    "load": "load.ogg",
    "overrun": "overrun.ogg",
    "crackle": "crackle.ogg"
  }
}
```

If a pack or layer is missing, the audio engine uses procedural fallback automatically.
