/**
 * Diesel powertrain for a heavy-haul tractor.
 *
 * Modelled on a 600 hp / 2050 lb-ft class engine behind an 18-speed manual with
 * a deep-reduction crawler set and a 4.56 rear axle -- the sort of spec actually
 * ordered for superload work, where the job is starting 200,000 lb on a grade
 * rather than running fast.
 */

const RPM_TO_RADS = Math.PI / 30;

/**
 * Torque curve sample points: [rpm, newton-metres].
 * Peak torque 2780 Nm (2050 lb-ft) held from 1100-1400 rpm, peak power near
 * 1800 rpm, hard governor cut above 2100.
 */
const TORQUE_CURVE = [
  [0, 0],
  [500, 900],
  [600, 1500],
  [800, 2100],
  [1000, 2600],
  [1100, 2780],
  [1200, 2780],
  [1400, 2780],
  [1500, 2700],
  [1600, 2580],
  [1800, 2380],
  [1900, 2180],
  [2000, 1900],
  [2100, 1500],
  [2200, 0],
];

/** Engine braking torque (negative) with the compression brake off. */
const DRAG_CURVE = [
  [0, 0],
  [600, -180],
  [1000, -280],
  [1400, -390],
  [1800, -500],
  [2100, -600],
];

function sampleCurve(curve, rpm) {
  if (rpm <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (rpm >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (rpm <= x1) {
      const [x0, y0] = curve[i - 1];
      const t = (rpm - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return last[1];
}

/**
 * 18-speed ratio set, deep reduction through overdrive. Index 0 is the crawler
 * gear used for starting a superload; top gear is a slight overdrive.
 */
export const GEAR_RATIOS = [
  14.40, 12.29, 8.51, 7.26, 5.72, 4.88, 4.03, 3.43, 2.71,
  2.31, 1.79, 1.53, 1.20, 1.02, 0.87, 0.80, 0.76, 0.73,
];

export const REVERSE_RATIOS = [-15.06, -12.85, -4.46, -3.80];

export class Powertrain {
  constructor({
    finalDrive = 4.56,
    engineInertia = 3.8,       // kg m^2, flywheel included
    drivelineEfficiency = 0.92,
    idleRpm = 600,
    maxRpm = 2100,
  } = {}) {
    this.finalDrive = finalDrive;
    this.engineInertia = engineInertia;
    this.drivelineEfficiency = drivelineEfficiency;
    this.idleRpm = idleRpm;
    this.maxRpm = maxRpm;

    this.rpm = idleRpm;
    this.gear = 4;             // index into GEAR_RATIOS
    this.reverseGear = 0;
    this.inReverse = false;
    this.neutral = false;

    this.clutch = 1;           // 0 = fully disengaged, 1 = locked
    this.clutchSlipping = false;
    this.throttle = 0;
    this.boost = 0;            // turbo spool, 0..1

    this.engineBrakeStage = 0; // 0 = off, 1..3 = compression brake stages
    this.running = true;
    this.stalled = false;

    // Riding a slipping clutch to move 200,000 lb in too tall a gear is the
    // classic way to destroy one. Heat accumulates while it slips and the
    // capacity falls away as it cooks, so picking the right gear matters.
    this.clutchTempC = 20;
    this.clutchWear = 0;
    this.overRev = false;
    this.overRevDamage = 0;

    this.outputTorque = 0;
    this.wheelTorque = 0;
  }

  get gearRatio() {
    if (this.neutral) return 0;
    return this.inReverse ? REVERSE_RATIOS[this.reverseGear] : GEAR_RATIOS[this.gear];
  }

  get totalRatio() {
    return this.gearRatio * this.finalDrive;
  }

  /** Human-readable gear label for the dash. */
  get gearLabel() {
    if (this.neutral) return 'N';
    if (this.inReverse) return `R${this.reverseGear + 1}`;
    const g = this.gear;
    if (g === 0) return 'C1';
    if (g === 1) return 'C2';
    return `${g - 1}`;
  }

  shiftUp() {
    if (this.inReverse) return;
    if (this.neutral) { this.neutral = false; return; }
    if (this.gear < GEAR_RATIOS.length - 1) this.gear++;
  }

  shiftDown() {
    if (this.inReverse) return;
    if (this.neutral) { this.neutral = false; return; }
    if (this.gear > 0) this.gear--;
  }

  selectReverse() {
    this.inReverse = true;
    this.neutral = false;
    this.reverseGear = 0;
  }

  selectForward() {
    this.inReverse = false;
    this.neutral = false;
  }

  /** Peak torque the engine can make right now, accounting for turbo spool. */
  availableTorque(rpm) {
    return sampleCurve(TORQUE_CURVE, rpm);
  }

  /**
   * Advances the engine and returns the torque delivered to the drive axles.
   *
   * @param dt            timestep, seconds
   * @param driveWheelOmega average angular velocity of the drive wheels, rad/s
   * @param wheelRadius   effective rolling radius, metres
   */
  update(dt, driveWheelOmega, wheelRadius) {
    const ratio = this.totalRatio;

    // Turbo lag: boost chases throttle, and torque below full boost is reduced.
    // A big diesel does not make 2050 lb-ft the instant you touch the pedal.
    const boostTarget = this.throttle;
    const spoolRate = boostTarget > this.boost ? 2.6 : 5.0;
    this.boost += (boostTarget - this.boost) * Math.min(1, spoolRate * dt);

    if (this.neutral || ratio === 0 || this.clutch < 0.05) {
      // Free-revving: engine only fights its own inertia and internal drag.
      const drive = this.availableTorque(this.rpm) * this.throttle * (0.45 + 0.55 * this.boost);
      const drag = sampleCurve(DRAG_CURVE, this.rpm) * (1 - this.throttle);
      const net = drive + drag;
      let omega = this.rpm * RPM_TO_RADS + (net / this.engineInertia) * dt;
      this.rpm = Math.max(this.idleRpm * 0.6, omega / RPM_TO_RADS);
      this.applyGovernor(dt);
      this.outputTorque = 0;
      this.wheelTorque = 0;
      return 0;
    }

    // Engine speed demanded by the road through the driveline.
    const drivenRpm = Math.abs(driveWheelOmega * ratio) / RPM_TO_RADS;

    // Clutch slips when the road would drag the engine below idle -- this is
    // what lets the rig creep away from a stop without stalling, and what makes
    // launching a superload in too tall a gear burn the clutch instead of moving.
    this.clutchSlipping = drivenRpm < this.idleRpm * 1.05;
    if (this.clutchSlipping) {
      const target = Math.max(this.idleRpm, this.idleRpm + this.throttle * 900);
      this.rpm += (target - this.rpm) * Math.min(1, 6 * dt);
    } else {
      // The road drives the engine through an engaged clutch, so far too tall a
      // downshift really can spin it past the governor. It cannot go
      // arbitrarily high though: past the float point the valvetrain gives up,
      // which is modelled as a hard ceiling plus a damage counter rather than a
      // five-figure tachometer reading.
      this.overRev = drivenRpm > this.maxRpm * 1.08;
      if (this.overRev) this.overRevDamage += (drivenRpm - this.maxRpm) * dt * 1e-5;
      this.rpm = Math.min(drivenRpm, this.maxRpm * 1.22);
    }
    this.applyGovernor(dt);

    // Torque production.
    const peak = this.availableTorque(this.rpm);
    let engineTorque = peak * this.throttle * (0.45 + 0.55 * this.boost);

    // Internal drag plus compression brake when off throttle.
    const drag = sampleCurve(DRAG_CURVE, this.rpm) * (1 - this.throttle);
    engineTorque += drag;

    if (this.engineBrakeStage > 0 && this.throttle < 0.05) {
      // A three-stage compression brake roughly matches engine output at rated
      // speed; this is the primary retarder on a long descent.
      const stageFactor = [0, 0.45, 0.75, 1.0][this.engineBrakeStage];
      const jake = -sampleCurve(TORQUE_CURVE, this.rpm) * 0.78 * stageFactor;
      engineTorque += jake;
    }

    // A slipping clutch can only transmit its holding capacity, and that
    // capacity fades as it heats.
    if (this.clutchSlipping) {
      const heatFade = Math.max(0.35, 1 - Math.max(0, this.clutchTempC - 250) / 500);
      const capacity = 3400 * this.clutch * heatFade;
      engineTorque = Math.max(-capacity, Math.min(capacity, engineTorque));

      // Slip power is the torque times the speed difference across the disc.
      const slipRads = Math.abs(this.rpm - drivenRpm) * RPM_TO_RADS;
      this.clutchTempC += (Math.abs(engineTorque) * slipRads * dt) / 5200;
      this.clutchWear += (Math.abs(engineTorque) * slipRads * dt) / 4.5e7;
    }
    this.clutchTempC -= (this.clutchTempC - 20) * Math.min(1, 0.09 * dt);

    this.outputTorque = engineTorque;
    this.wheelTorque = engineTorque * ratio * this.drivelineEfficiency * this.clutch;
    return this.wheelTorque;
  }

  applyGovernor(dt) {
    if (this.rpm > this.maxRpm) {
      // Electronic governor cuts fuel rather than letting it over-rev.
      this.rpm = this.maxRpm + (this.rpm - this.maxRpm) * Math.exp(-12 * dt);
      this.throttle = Math.min(this.throttle, 0.05);
    }
    if (this.rpm < this.idleRpm && !this.stalled) this.rpm = this.idleRpm;
  }

  /**
   * Road speed the current gear would give at a chosen engine speed, m/s.
   * Used by the shift-assist readout to suggest the next gear.
   */
  speedAtRpm(rpm, wheelRadius, gearIndex = this.gear) {
    const ratio = GEAR_RATIOS[gearIndex] * this.finalDrive;
    return (rpm * RPM_TO_RADS / ratio) * wheelRadius;
  }

  /** Engine output in horsepower, for the dash. */
  get horsepower() {
    return (this.outputTorque * this.rpm * RPM_TO_RADS) / 745.7;
  }

  /**
   * Suggests the gear that would put the engine in its torque band at the
   * current road speed, and shifts toward it one gear at a time.
   *
   * Hand-shifting eighteen gears is a skill in its own right and not what most
   * people are here for, so this drives the box when shift assist is enabled.
   * It deliberately shifts one gear per call with a cooldown, the way a driver
   * would, rather than teleporting to the right ratio.
   */
  autoShift(dt, wheelRadius, roadSpeed) {
    this._shiftTimer = Math.max(0, (this._shiftTimer ?? 0) - dt);
    if (this.inReverse || this.neutral) return;

    const wheelOmega = Math.abs(roadSpeed) / wheelRadius;
    const rpmIn = (g) => (wheelOmega * GEAR_RATIOS[g] * this.finalDrive) / RPM_TO_RADS;
    const current = rpmIn(this.gear);

    // Hitting a grade at road speed means dropping a lot of gears in a hurry.
    // Waiting for the engine to lug down one ratio at a time loses more speed
    // on every shift than the next gear can pull back, and the rig walks itself
    // to a stop halfway up -- so a badly lugging engine skips straight to the
    // gear that suits the road speed instead of stepping down.
    if (current < 900 && this.gear > 0) {
      let best = this.gear;
      for (let g = this.gear - 1; g >= 0; g--) {
        if (rpmIn(g) <= this.maxRpm * 0.92) best = g;
        if (rpmIn(g) >= 1450) break;
      }
      if (best !== this.gear) {
        this.gear = best;
        this._shiftTimer = 0.3;
        return;
      }
    }

    if (this._shiftTimer > 0) return;

    // Upshift once the next gear still pulls in the torque band; downshift
    // before the engine falls out of it. The band is wide on a big diesel, but
    // under this much load the bottom of it is where the rig stops climbing.
    if (this.gear < GEAR_RATIOS.length - 1 && current > 1800 && rpmIn(this.gear + 1) > 1300) {
      this.gear++;
      this._shiftTimer = 0.75;
    } else if (this.gear > 0 && current < 1300 && rpmIn(this.gear - 1) < this.maxRpm * 0.92) {
      this.gear--;
      this._shiftTimer = 0.35;
    }
  }
}
