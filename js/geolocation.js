/**
 * GPS speed provider for Tesla Browser
 * Uses Geolocation API watchPosition + speed (m/s → km/h)
 */

export class GeolocationService {
  constructor() {
    this.watching = false;
    this.watchId = null;
    this.speedKmh = 0;
    this.accuracy = null;
    this.lastFix = null;
    this.error = null;
    this.status = 'off'; // off | pending | live | error | denied
    this._listeners = new Set();
    this._fallbackSpeed = 0;
    this._lastPos = null;
    this._lastTs = 0;
  }

  onUpdate(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const payload = {
      speedKmh: this.speedKmh,
      accuracy: this.accuracy,
      status: this.status,
      error: this.error,
      lastFix: this.lastFix,
    };
    for (const fn of this._listeners) fn(payload);
  }

  get supported() {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  start() {
    if (!this.supported) {
      this.status = 'error';
      this.error = 'Geolocation not supported';
      this._emit();
      return;
    }
    if (this.watching) return;

    this.status = 'pending';
    this.error = null;
    this._emit();

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._onPosition(pos),
      (err) => this._onError(err),
      {
        enableHighAccuracy: true,
        // 0 = never hand us a cached fix. A 500 ms-old fix is 500 ms of latency we chose
        // to accept; the whole job here is to deliver what the receiver just measured.
        maximumAge: 0,
        timeout: 12000,
      }
    );
    this.watching = true;
  }

  stop() {
    if (this.watchId != null && this.supported) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
    this.watching = false;
    this.status = 'off';
    this._emit();
  }

  _onPosition(pos) {
    const { coords, timestamp } = pos;
    this.accuracy = coords.accuracy;
    this.lastFix = timestamp;
    this.status = 'live';
    this.error = null;

    let speedMs = coords.speed;

    // coords.speed is the receiver's own Doppler solution: fresh and already clean.
    // Only when the browser withholds it do we derive speed from two positions — that path
    // IS noisy, and it is the only one that earns any smoothing further down.
    if (speedMs == null || Number.isNaN(speedMs) || speedMs < 0) {
      this.speedSource = 'derived';
      speedMs = this._estimateSpeed(coords.latitude, coords.longitude, timestamp);
    } else {
      this.speedSource = 'doppler';
    }

    // m/s → km/h; clamp wild spikes
    let kmh = (speedMs || 0) * 3.6;
    if (kmh > 320) kmh = this.speedKmh; // ignore absurd spikes
    // Zero-out crawl noise when accuracy is poor and speed tiny
    if (kmh < 1.2 && (this.accuracy == null || this.accuracy > 40)) {
      kmh = 0;
    }
    // Teleport guard ONLY. This used to clamp to 12 km/h per fix — at ~1 fix/s that capped
    // the readout at 12 km/h/s while the car pulls 16–30, so every hard launch drove the
    // number progressively further behind the dash. We must never overwrite a change the
    // receiver actually measured; 40 still rejects a genuinely broken fix.
    const prev = this.speedKmh || 0;
    const jump = kmh - prev;
    if (Math.abs(jump) > 40 && prev > 8) {
      kmh = prev + Math.sign(jump) * 40;
    }
    // Doppler speed goes through UNTOUCHED — smoothing it here only re-adds latency, and the
    // display already ramps between fixes. The derived fallback is genuinely noisy, so that
    // one (and only that one) still gets a light average.
    this.speedKmh = this.speedSource === 'derived' ? prev * 0.25 + kmh * 0.75 : kmh;
    this._emit();
  }

  _estimateSpeed(lat, lon, ts) {
    if (!this._lastPos || !this._lastTs) {
      this._lastPos = { lat, lon };
      this._lastTs = ts;
      return 0;
    }
    const dt = (ts - this._lastTs) / 1000;
    if (dt <= 0.05) return this.speedKmh / 3.6;

    const dist = haversineMeters(this._lastPos.lat, this._lastPos.lon, lat, lon);
    this._lastPos = { lat, lon };
    this._lastTs = ts;

    // Ignore teleport jumps
    if (dist > 200 && dt < 2) return this.speedKmh / 3.6;
    return dist / dt;
  }

  _onError(err) {
    this.error = err.message || 'GPS error';
    if (err.code === 1) this.status = 'denied';
    else this.status = 'error';
    this._emit();
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
