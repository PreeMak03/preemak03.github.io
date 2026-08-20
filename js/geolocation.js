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
    this._stopped = true;   // standstill latch (see the deadband in _onPosition)
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
      fixHz: this.fixHz,
      speedSource: this.speedSource,
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
    this._startBoost();
  }

  stop() {
    if (this.watchId != null && this.supported) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    if (this._boostTimer) {
      window.clearTimeout(this._boostTimer);
      this._boostTimer = null;
    }
    this.watchId = null;
    this.watching = false;
    this.status = 'off';
    this._emit();
  }

  /**
   * Ask the receiver for a fix between watchPosition callbacks, to lift the update rate as
   * high as the hardware will actually go. Self-limiting on purpose: if the watch is already
   * fast, or the extra calls keep returning the SAME fix (no new data to be had), the poll
   * backs off — so it can never turn into load that costs more than it buys.
   * @returns {void}
   */
  _startBoost() {
    let interval = 250;
    let dupes = 0;
    const schedule = () => {
      if (!this.watching) return;
      this._boostTimer = window.setTimeout(run, interval);
    };
    const run = () => {
      if (!this.watching) return;
      if ((this.fixHz || 0) >= 4) { interval = 1000; return schedule(); } // already plenty
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          // A novel fix here means the poll beat the watch to it — real latency won, so stay
          // fast. Otherwise this receiver has nothing more to give and we settle into a slow
          // probe (~0.5 calls/s) rather than burning the MCU for duplicates.
          const novel = this._onPosition(pos);
          if (novel) { dupes = 0; interval = 200; }
          else if (++dupes >= 6) { interval = Math.min(2000, interval * 1.6); dupes = 0; }
          schedule();
        },
        () => { interval = Math.min(2000, interval * 2); schedule(); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 900 }
      );
    };
    schedule();
  }

  /** @returns {boolean} true if this was a NEW fix (not the same one served twice) */
  _onPosition(pos) {
    const { coords, timestamp } = pos;
    // watchPosition and the booster can hand us the identical fix; only act on new data.
    if (timestamp === this._lastSeenTs) return false;
    if (this._lastSeenTs) {
      const gap = (timestamp - this._lastSeenTs) / 1000;
      if (gap > 0.005 && gap < 10) {
        this.fixHz = this.fixHz ? this.fixHz * 0.7 + (1 / gap) * 0.3 : 1 / gap;
      }
    }
    this._lastSeenTs = timestamp;
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
    // Standstill deadband.
    //
    // A parked car's receiver still reports 0.3-1.5 km/h of Doppler noise, so
    // this has to be zeroed or the readout never reaches 0. The old rule only
    // did it when accuracy was POOR (>40 m), which is backwards — with a normal
    // 5-15 m fix, which is what you get in the open, the noise went straight
    // through and the speed sat at 1 km/h forever, engine idling at a red light.
    //
    // Hysteresis so a genuine crawl cannot flicker the engine on and off: once
    // stopped it takes a clear reading to count as moving again.
    const stopAt = this.accuracy != null && this.accuracy <= 40 ? 1.8 : 2.8;
    const goAt = stopAt + 1.0;
    if (this._stopped ? kmh < goAt : kmh < stopAt) {
      kmh = 0;
      this._stopped = true;
    } else {
      this._stopped = false;
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
    return true;
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
