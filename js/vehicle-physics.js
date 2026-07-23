/**
 * Simulation speed limiter
 *
 * Hard rate limit: ±33 km/h per second toward fader demand.
 * GPS mode does NOT use this — it tracks raw GPS as often as the browser reports.
 */

import { clamp } from './animations.js';

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
  }

  setTarget(kmh) {
    this.targetSpeed = clamp(kmh, 0, this.limits.maxSpeedKmh);
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
    const err = this.targetSpeed - this.vehicleSpeed;

    let delta = clamp(err, -maxStep, maxStep);
    let next = this.vehicleSpeed + delta;

    // Snap when extremely close
    if (Math.abs(this.targetSpeed - next) < 0.08) {
      next = this.targetSpeed;
      delta = next - this.vehicleSpeed;
    }

    next = clamp(next, 0, this.limits.maxSpeedKmh);

    const rate = delta / dt; // km/h/s (≈ ±33 when chasing target)
    this.prevSpeed = this.vehicleSpeed;
    this.vehicleSpeed = next;
    this.accelKmhps = rate;

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
  }
}

/** @deprecated use SIM_RATE — kept so old imports don't break */
export const TESLA_PLAID = {
  ...SIM_RATE,
  maxAccelMps2: SIM_RATE.maxDeltaKmhPerSec / 3.6,
  maxDecelMps2: SIM_RATE.maxDeltaKmhPerSec / 3.6,
  zeroTo100Sec: 100 / SIM_RATE.maxDeltaKmhPerSec,
};
