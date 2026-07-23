/**
 * THOR-style sample pack loader
 * Loads layered loops from assets/samples/<id>/manifest.json
 * Missing layers → null (caller uses procedural fallback)
 */

const LAYER_KEYS = ['idle', 'body', 'high', 'load', 'overrun', 'crackle'];

/**
 * @typedef {Object} SamplePack
 * @property {string} id
 * @property {string} name
 * @property {number} refRpm
 * @property {Record<string, AudioBuffer|null>} buffers
 * @property {boolean} ok
 */

export class SamplePackLoader {
  /**
   * @param {AudioContext} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {Map<string, SamplePack>} */
    this.cache = new Map();
    this.basePath = 'assets/samples';
  }

  /**
   * @param {string} packId
   * @returns {Promise<SamplePack|null>}
   */
  async load(packId) {
    if (!packId || !this.ctx) return null;
    if (this.cache.has(packId)) return this.cache.get(packId);

    const root = `${this.basePath}/${packId}`;
    let manifest;
    try {
      const res = await fetch(`${root}/manifest.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      manifest = await res.json();
    } catch (e) {
      console.info(`[SamplePack] no pack "${packId}" — procedural fallback`, e.message || e);
      this.cache.set(packId, null);
      return null;
    }

    /** @type {SamplePack} */
    const pack = {
      id: manifest.id || packId,
      name: manifest.name || packId,
      refRpm: manifest.refRpm || 4000,
      buffers: {},
      ok: false,
    };

    const layers = manifest.layers || {};
    let loaded = 0;

    await Promise.all(
      LAYER_KEYS.map(async (key) => {
        const file = layers[key];
        if (!file) {
          pack.buffers[key] = null;
          return;
        }
        try {
          const buf = await this._fetchDecode(`${root}/${file}`);
          pack.buffers[key] = buf;
          if (buf) loaded += 1;
        } catch (err) {
          console.warn(`[SamplePack] layer ${key} failed`, err);
          pack.buffers[key] = null;
        }
      })
    );

    pack.ok = loaded > 0;
    this.cache.set(packId, pack.ok ? pack : null);
    if (pack.ok) {
      console.info(`[SamplePack] loaded "${pack.id}" (${loaded} layers)`);
    }
    return pack.ok ? pack : null;
  }

  /**
   * @param {string} url
   * @returns {Promise<AudioBuffer>}
   */
  async _fetchDecode(url) {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    const arr = await res.arrayBuffer();
    // decodeAudioData may detach buffer; copy not needed if we don't reuse arr
    return await this.ctx.decodeAudioData(arr.slice(0));
  }
}

/**
 * Create a looping BufferSource + gain + optional filter for a layer
 */
export function createSampleLayer(ctx, buffer, dest, { loop = true } = {}) {
  if (!buffer) return null;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = loop;
  src.playbackRate.value = 1;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 8000;

  const gain = ctx.createGain();
  gain.gain.value = 0;

  src.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  src.start();

  return { src, filter, gain, buffer };
}
