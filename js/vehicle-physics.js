/**
 * Simulation speed limiter
 *
 * Hard rate limit: ±33 km/h per second toward fader demand.
 * GPS mode does NOT use this — it tracks raw GPS as often as the browser reports.
 */

import { clamp } from './animations.js';

/**
 * Window the acceleration estimate is averaged over. Long enough to bridge the
 * gap between target steps (a slider drag, a 1 Hz GPS fix), short enough that a
 * real launch still reads full scale almost immediately.
 */
const ACCEL_WINDOW_SEC = 0.45;

/** How quickly the vehicle eases onto a new demand. See update(). */
const TARGET_EASE_SEC = 0.35;

/** ±33 km/h/s rate limit for Simulation fader */
export const SIM_RATE = {
  label: '±33 km/h/s',
  /** Max speed change per second (both accel and decel) */
  maxDeltaKmhPerSec: 33,
  maxSpeedKmh: 200,
};

/**
 * Integrates target (fader demand) → vehicleSpeed with fixed ±rate limit.
 */
export class VehiclePhysics {
  constructor(limits = SIM_RATE) {
    this.limits = limits;
    this.vehicleSpeed = 0; // km/h actual
    this.targetSpeed = 0; // km/h demand
    this.throttle = 0;
    this.brake = 0;
    this.accelKmhps = 0; // km/h per second
    this.prevSpeed = 0;
    /** Recent (time, speed) samples — see the note on accelKmhps in update(). */
    this._hist = [];
    /** Demand after easing — what the rate limiter actually chases. */
    this._targetEased = 0;
  }

  setTarget(kmh) {
    this.targetSpeed = clamp(kmh, 0, this.limits.maxSpeedKmh);
  }

  /** @deprecated kept so any caller reading the raw demand still works */
  get easedTarget() {
    return this._targetEased;
  }

  /**
   * @param {number} dt seconds — should be real wall-clock dt (not FPS-starved)
   */
  update(dt) {
    // Allow up to 100ms steps so low FPS still advances real time correctly.
    // (Old 50ms cap made 0–100 take ~10s on ~10fps displays.)
    if (!(dt > 0) || Number.isNaN(dt)) dt = 1 / 60;
    dt = Math.min(0.1, Math.max(0.001, dt));

    const maxRate = this.limits.maxDeltaKmhPerSec; // 33 km/h/s
    const maxStep = maxRate * dt;

    // Ease toward the demand instead of slamming into it.
    //
    // Chasing the raw target means the vehicle always moves at the rate limit
    // or not at all: a 4 km/h nudge of the slider is covered in 0.12 s flat out
    // and then dead stop. Real motion is continuous, and the difference is
    // audible — the engine reads that on/off motion as revs diving and climbing
    // once per slider step. For a big demand change the rate limiter still
    // governs (a launch is unchanged, it is limited by maxRate either way);
    // this only rounds off the arrival.
    const k = 1 - Math.exp(-dt / TARGET_EASE_SEC);
    this._targetEased += (this.targetSpeed - this._targetEased) * k;
    const err = this._targetEased - this.vehicleSpeed;

    let delta = clamp(err, -maxStep, maxStep);
    let next = this.vehicleSpeed + delta;

    // Snap when extremely close
    if (Math.abs(this.targetSpeed - next) < 0.08) {
      next = this.targetSpeed;
      delta = next - this.vehicleSpeed;
    }

    next = clamp(next, 0, this.limits.maxSpeedKmh);

    const rate = delta / dt; // instantaneous limiter rate (±33 while chasing)
    this.prevSpeed = this.vehicleSpeed;
    this.vehicleSpeed = next;

    // Acceleration is measured over a short WINDOW, not from the limiter's
    // instantaneous rate.
    //
    // `rate` is how fast the rate limiter is currently moving, and the limiter
    // only ever moves at its maximum or not at all. So whenever the target
    // arrives in steps — dragging the speed slider, or a GPS fix landing once a
    // second — the reported acceleration is a square wave slamming between
    // ±33 km/h/s and zero, however gently the speed is actually changing.
    // Measured while easing the slider down 4 km/h per second: accel alternated
    // -33 and 0 once a second, the revs dived ~800 rpm and climbed back each
    // time, and the pitch swung 6.2 semitones. The engine was faithfully
    // reproducing a signal that did not describe the car.
    //
    // The slope across the window is what the vehicle is actually averaging: it
    // still reads the full ±33 during a sustained pull, and reads ~-4 when the
    // speed is easing down at 4 km/h/s.
    const now = (this._clock = (this._clock || 0) + dt);
    this._hist.push({ t: now, v: next });
    while (this._hist.length > 2 && now - this._hist[0].t > ACCEL_WINDOW_SEC) this._hist.shift();
    const first = this._hist[0];
    const span = now - first.t;
    this.accelKmhps = span > 0.05 ? (next - first.v) / span : rate;

    // Throttle / brake from rate for audio load
    if (rate > 1) {
      this.throttle = clamp(rate / this.limits.maxDeltaKmhPerSec, 0.15, 1);
      this.brake = 0;
    } else if (rate < -1) {
      this.brake = clamp(-rate / this.limits.maxDeltaKmhPerSec, 0.15, 1);
      this.throttle = this.targetSpeed < 1 ? 0 : 0.05;
    } else if (this.vehicleSpeed < 0.8 && this.targetSpeed < 0.5) {
      this.throttle = 0;
      this.brake = 0;
    } else {
      // Holding speed — light cruise throttle for audio
      this.throttle = this.targetSpeed > 2 ? 0.18 : 0;
      this.brake = 0;
    }

    return {
      speed: this.vehicleSpeed,
      throttle: this.throttle,
      brake: this.brake,
      accelKmhps: this.accelKmhps,
      /** m/s² equivalent for any legacy callers */
      accelMps2: rate / 3.6,
    };
  }

  reset(speed = 0) {
    this.vehicleSpeed = speed;
    this.targetSpeed = speed;
    this.throttle = 0;
    this.brake = 0;
    this.accelKmhps = 0;
    this._hist = [];
    this._targetEased = speed;
  }
}

/** @deprecated use SIM_RATE — kept so old imports don't break */
export const TESLA_PLAID = {
  ...SIM_RATE,
  maxAccelMps2: SIM_RATE.maxDeltaKmhPerSec / 3.6,
  maxDecelMps2: SIM_RATE.maxDeltaKmhPerSec / 3.6,
  zeroTo100Sec: 100 / SIM_RATE.maxDeltaKmhPerSec,
};
