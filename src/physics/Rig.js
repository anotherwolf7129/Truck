import { Vector3 } from 'three';
import { VehicleUnit, Wheel } from './Vehicle.js';
import { BallJoint, RollCoupling, YawLimit } from './Constraints.js';
import { Powertrain } from './Powertrain.js';
import { AirSystem, BrakeGroup } from './Brakes.js';
import { TRUCK_TIRE, STEER_TIRE } from './Tire.js';

const GRAVITY = new Vector3(0, -9.81, 0);
const LOCAL_FWD = new Vector3(0, 0, 1);
const LOCAL_RIGHT = new Vector3(1, 0, 0);
const _tmp = new Vector3();

const N_TO_LB = 0.2248089431;

// Every pivot on the combination sits at this height above the road, which is
// where a real fifth wheel plate lives.
const COUPLING_HEIGHT = 1.329;

/**
 * The complete heavy haul combination: 6x4 tractor, two-axle jeep dolly, and a
 * multi-axle lowboy carrying the load.
 *
 * Three separate rigid bodies coupled at two pivots is the smallest model that
 * reproduces the behaviour that defines this kind of driving -- the trailer
 * tracking well inside the tractor's path through a corner, the load pushing the
 * drives around under braking, and the two-pivot sway that builds if you correct
 * too fast at speed.
 */
export class Rig {
  constructor(options = {}) {
    const cargo = options.cargo ?? {
      name: 'Substation transformer',
      mass: 68000,
      size: new Vector3(3.6, 3.05, 8.4),
      centerHeight: 2.10,
    };
    this.cargo = cargo;

    this.tractor = this.buildTractor();
    this.jeep = this.buildJeep();
    this.trailer = this.buildTrailer(cargo);

    this.units = [this.tractor, this.jeep, this.trailer];

    // --- Couplings ---------------------------------------------------------
    // Anchor heights put every pivot at a 1.27 m coupling height, which is where
    // a real fifth wheel sits. See tools/layout.mjs for the static load analysis
    // these positions come from.
    //
    // Tractor fifth wheel -> jeep kingpin
    this.hitchA = new BallJoint(
      this.tractor.body, new Vector3(0, 0.146, -2.10),
      this.jeep.body, new Vector3(0, 0.337, 2.20)
    );
    this.rollA = new RollCoupling(this.tractor.body, this.jeep.body, { stiffness: 0.85 });
    this.yawA = new YawLimit(this.tractor.body, this.jeep.body, { limit: 1.45 });

    // Jeep fifth wheel -> lowboy gooseneck. The jeep's rear coupling sits just
    // ahead of its own axles so that a useful share of the deck load carries
    // forward onto the tractor's drives instead of levering the nose light.
    this.hitchB = new BallJoint(
      this.jeep.body, new Vector3(0, 0.337, -0.30),
      this.trailer.body, new Vector3(0, COUPLING_HEIGHT - this.trailer.comHeight, 6.30)
    );
    this.rollB = new RollCoupling(this.jeep.body, this.trailer.body, { stiffness: 0.88 });
    this.yawB = new YawLimit(this.jeep.body, this.trailer.body, { limit: 1.30 });

    this.constraints = [this.hitchA, this.rollA, this.yawA, this.hitchB, this.rollB, this.yawB];
    this.solverIterations = 12;

    // --- Systems -----------------------------------------------------------
    this.powertrain = new Powertrain();
    this.air = new AirSystem();

    // --- Controls ----------------------------------------------------------
    this.steerInput = 0;        // -1..1 requested
    this.steerAngle = 0;        // actual road wheel angle, radians
    this.maxSteerAngle = 0.66;  // ~38 degrees
    this.steerRate = 0.9;       // rad/s at the road wheel; a truck box is slow
    this.throttle = 0;
    this.brake = 0;
    this.trailerSteerInput = 0; // steerman control for the rear axle group
    this.trailerSteerAngle = 0;
    this.maxTrailerSteer = 0.44;
    this.diffLock = false;

    this.wheelbase = 5.10;
    this.steerTrack = 2.04;
    this.trailerHalfTrack = 0.98;

    // Ambient wind, world space. Escort crews call wind constantly on a tall
    // load, and a permit move is normally shut down above about 30 mph gusts.
    this.wind = new Vector3();

    this.rolloverWarning = 0;
    this.jackknifeWarning = 0;
    this.telemetry = {};
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  buildTractor() {
    const mountY = -0.35;
    const steerBrake = () => new BrakeGroup({ maxTorque: 7000, thermalMass: 20000 });
    const driveBrake = () => new BrakeGroup({ maxTorque: 8600, thermalMass: 26000 });

    const wheels = [];
    // Steer axle
    for (const side of [-1, 1]) {
      wheels.push(new Wheel({
        position: new Vector3(side * 1.02, mountY, 2.20),
        steerable: true,
        tire: STEER_TIRE,
        restLength: 0.32,
        stiffness: 480000,
        damping: 26000,
        maxTravel: 0.14,
        brake: steerBrake(),
        brakeShare: 0.85,
      }));
    }
    // Drive tandem, dual tires
    for (const z of [-1.55, -2.90]) {
      for (const side of [-1, 1]) {
        wheels.push(new Wheel({
          position: new Vector3(side * 0.94, mountY, z),
          driven: true,
          dual: true,
          tire: TRUCK_TIRE,
          restLength: 0.32,
          stiffness: 560000,
          damping: 34000,
          maxTravel: 0.17,
          brake: driveBrake(),
        }));
      }
    }

    const unit = new VehicleUnit({
      name: 'tractor',
      mass: 9500,
      size: new Vector3(2.5, 3.4, 7.6),
      wheels,
      position: new Vector3(0, 1.182, 0),
    });
    unit.antiRollStiffness = 300000;
    // A conventional cab pushes a large hole in the air, but the load behind it
    // is wider still, so most of the combination's drag is charged to the
    // trailer below.
    unit.dragArea = 4.6;
    unit.sideArea = 6.0;
    unit.pressureCenterHeight = 0.9;
    // Frame rails, ~0.42 m off the road at ride height.
    unit.chassisPoints = [
      new Vector3(-0.5, -0.70, 3.0), new Vector3(0.5, -0.70, 3.0),
      new Vector3(-0.5, -0.70, -3.4), new Vector3(0.5, -0.70, -3.4),
    ];
    return unit;
  }

  buildJeep() {
    const mountY = -0.20;
    const wheels = [];
    for (const z of [-1.00, -2.35]) {
      for (const side of [-1, 1]) {
        wheels.push(new Wheel({
          position: new Vector3(side * 0.94, mountY, z),
          dual: true,
          tire: TRUCK_TIRE,
          restLength: 0.28,
          stiffness: 780000,
          damping: 42000,
          maxTravel: 0.15,
          brake: new BrakeGroup({ maxTorque: 8200, thermalMass: 25000, lag: 0.26 }),
        }));
      }
    }

    const unit = new VehicleUnit({
      name: 'jeep',
      mass: 5000,
      size: new Vector3(2.5, 1.4, 5.2),
      wheels,
      position: new Vector3(0, 0.992, -4.30),
    });
    unit.antiRollStiffness = 320000;
    unit.dragArea = 0.5;
    unit.sideArea = 3.4;
    unit.pressureCenterHeight = 0.4;
    unit.chassisPoints = [
      new Vector3(-0.6, -0.55, 1.6), new Vector3(0.6, -0.55, 1.6),
      new Vector3(-0.6, -0.55, -2.6), new Vector3(0.6, -0.55, -2.6),
    ];
    return unit;
  }

  /**
   * The lowboy. Four rear axles carry the deck load; the rearmost two steer,
   * operated either by the driver or by a steerman walking alongside.
   */
  buildTrailer(cargo) {
    const trailerTare = 14000;
    const mass = trailerTare + cargo.mass;
    const deckHeight = 0.55;

    // The load dominates the combined centre of gravity, and it sits high. This
    // is the single biggest handling factor on the rig: it sets the rollover
    // threshold, and it is why these moves crawl through corners a bobtail
    // tractor would take at forty.
    const comHeight = (cargo.mass * cargo.centerHeight + trailerTare * 0.90) / mass;

    // Suspension geometry is derived from that centre of gravity rather than
    // hardcoded, so changing the load cannot silently leave the wheels buried
    // in the road or hanging above it.
    const radius = 0.46;
    const restLength = 0.26;
    const staticCompression = 0.047;
    const mountY = -(comHeight - (restLength - staticCompression) - radius);

    const wheels = [];
    const axleZ = [-4.10, -5.45, -6.80, -8.15];
    axleZ.forEach((z, i) => {
      for (const side of [-1, 1]) {
        wheels.push(new Wheel({
          position: new Vector3(side * 0.98, mountY, z),
          dual: true,
          radius,
          tire: TRUCK_TIRE,
          restLength,
          stiffness: 700000,
          damping: 40000,
          maxTravel: 0.16,
          // The two rearmost axles steer to shorten the effective off-track
          // through tight corners.
          tandemSteer: i >= 2,
          brake: new BrakeGroup({ maxTorque: 8600, thermalMass: 26000, lag: 0.32 }),
          liftable: i === 1,
        }));
      }
    });

    const unit = new VehicleUnit({
      name: 'trailer',
      mass,
      size: new Vector3(3.6, cargo.size.y, 16.0),
      wheels,
      position: new Vector3(0, comHeight, -10.90),
    });
    unit.comHeight = comHeight;
    unit.deckHeight = deckHeight;
    unit.antiRollStiffness = 420000;
    unit.cargo = cargo;

    // The load itself is the aerodynamic problem: 3.6 m wide and 3 m tall of
    // flat, unfaired steel. Cd for a bluff box like this is close to 1.0.
    const frontal = cargo.size.x * cargo.size.y;
    unit.dragArea = frontal * 0.98;
    unit.sideArea = cargo.size.z * cargo.size.y * 0.85;
    unit.pressureCenterHeight = cargo.centerHeight - (comHeight - 0);

    // Underside of the well deck. At 0.55 m off the road this is the lowest
    // point on the whole combination and the first thing to touch on a crest.
    const deckLocalY = deckHeight - comHeight;
    unit.chassisPoints = [
      new Vector3(-1.3, deckLocalY, 4.6), new Vector3(1.3, deckLocalY, 4.6),
      new Vector3(-1.3, deckLocalY, 0.0), new Vector3(1.3, deckLocalY, 0.0),
      new Vector3(-1.3, deckLocalY, -3.2), new Vector3(1.3, deckLocalY, -3.2),
    ];
    return unit;
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  /**
   * Ackermann steering: the inside wheel turns more sharply than the outside so
   * both trace the same turn centre. On a long-wheelbase tractor this is very
   * visible at full lock.
   */
  applySteering(dt) {
    const target = this.steerInput * this.maxSteerAngle;
    const delta = target - this.steerAngle;
    const maxStep = this.steerRate * dt;
    this.steerAngle += Math.max(-maxStep, Math.min(maxStep, delta));

    const steerWheels = this.tractor.wheels.filter((w) => w.steerable);
    if (Math.abs(this.steerAngle) < 1e-4) {
      steerWheels.forEach((w) => { w.steerAngle = 0; });
    } else {
      const R = this.wheelbase / Math.tan(Math.abs(this.steerAngle));
      const sign = Math.sign(this.steerAngle);
      const inner = Math.atan(this.wheelbase / (R - this.steerTrack / 2));
      const outer = Math.atan(this.wheelbase / (R + this.steerTrack / 2));
      for (const w of steerWheels) {
        const isInner = Math.sign(w.position.x) === sign;
        w.steerAngle = sign * (isInner ? inner : outer);
      }
    }

    // Trailer rear steer, with self-centring when released.
    const tTarget = this.trailerSteerInput * this.maxTrailerSteer;
    this.trailerSteerAngle += (tTarget - this.trailerSteerAngle) * Math.min(1, 2.2 * dt);
    for (const w of this.trailer.wheels) {
      if (w.tandemSteer) w.steerAngle = this.trailerSteerAngle;
    }
  }

  /** Average angular velocity of the drive wheels, rad/s. */
  driveWheelOmega() {
    const driven = this.tractor.wheels.filter((w) => w.driven);
    if (!driven.length) return 0;
    return driven.reduce((s, w) => s + w.spin, 0) / driven.length;
  }

  // -------------------------------------------------------------------------
  // Simulation step
  // -------------------------------------------------------------------------

  step(dt, ground) {
    this.applySteering(dt);

    // --- Air and brakes ----------------------------------------------------
    const brakeDemand = this.air.parkingBrake ? 1 : this.brake;
    this.air.update(dt, this.brake, this.powertrain.rpm);

    const speed = Math.abs(this.tractor.forwardSpeed);
    for (const unit of this.units) {
      for (const w of unit.wheels) {
        w.brake.update(dt, brakeDemand, this.air.psi, speed);
      }
    }

    // --- Engine ------------------------------------------------------------
    this.powertrain.throttle = this.air.parkingBrake ? 0 : this.throttle;
    const wheelRadius = this.tractor.wheels.find((w) => w.driven).radius;
    let wheelTorque = this.powertrain.update(dt, this.driveWheelOmega(), wheelRadius);

    // A locked inter-axle differential sends torque to the axle with grip
    // instead of splitting it evenly into the wheel that is already spinning.
    if (this.diffLock) wheelTorque *= 1.0;

    // Reflect the engine and gearbox inertia down to the drive wheels. Through
    // a 33:1 crawler gear this is three orders of magnitude larger than the
    // wheels' own inertia; without it the tires spin up faster than the tire
    // model can respond and the rig sits at the bottom of every grade lighting
    // up its drives.
    const driven = this.tractor.wheels.filter((w) => w.driven);
    const ratio = this.powertrain.totalRatio;
    const reflected = this.powertrain.neutral || this.powertrain.clutch < 0.05
      ? 0
      : (this.powertrain.engineInertia * ratio * ratio * this.powertrain.clutch) /
        Math.max(1, driven.length);
    for (const w of driven) w.drivelineInertia = reflected;

    // --- Aerodynamics -------------------------------------------------------
    for (const unit of this.units) unit.applyAerodynamics(this.wind);

    // --- Per-unit dynamics --------------------------------------------------
    this.tractor.update(dt, ground, wheelTorque, brakeDemand, this.air.psi);
    this.jeep.update(dt, ground, 0, brakeDemand, this.air.psi);
    this.trailer.update(dt, ground, 0, brakeDemand, this.air.psi);

    // --- Integrate and solve -----------------------------------------------
    for (const unit of this.units) unit.body.integrateVelocity(dt, GRAVITY);

    for (let i = 0; i < this.solverIterations; i++) {
      this.hitchA.solve(dt);
      this.hitchB.solve(dt);
      this.rollA.solve();
      this.rollB.solve();
      this.yawA.solve();
      this.yawB.solve();
    }

    for (const unit of this.units) unit.body.integratePosition(dt);

    this.updateWarnings();
    this.updateTelemetry();
  }

  updateWarnings() {
    // Rollover risk is lateral acceleration measured against the load's static
    // stability factor -- half the track width over the centre of gravity
    // height. A tall deck load rolls long before the tires break away, so this,
    // not tire grip, is what limits corner speed on a heavy haul.
    const t = this.trailer;
    const ssf = this.trailerHalfTrack / (t.comHeight ?? 1.7);
    const latG = Math.abs(this.lateralAcceleration()) / 9.81;

    // Actual body roll is the other half of the picture: once the springs are
    // wound up and the inside wheels start to unload, the index climbs even if
    // the instantaneous acceleration eases off.
    const rollFraction = Math.abs(t.rollAngle) / 0.14; // ~8 degrees is committed

    // Wheels off the ground only mean a rollover if they are off on ONE side.
    // Cresting a rise lifts both sides at once, and that is airborne, not
    // tipping over.
    let leftUp = 0;
    let rightUp = 0;
    let leftTotal = 0;
    let rightTotal = 0;
    for (const w of t.wheels) {
      if (w.lifted) continue;
      const left = w.position.x < 0;
      if (left) { leftTotal++; if (!w.grounded) leftUp++; }
      else { rightTotal++; if (!w.grounded) rightUp++; }
    }
    const leftFrac = leftTotal ? leftUp / leftTotal : 0;
    const rightFrac = rightTotal ? rightUp / rightTotal : 0;
    const oneSideLifted = Math.abs(leftFrac - rightFrac);

    this.rolloverWarning = Math.min(
      1.5,
      Math.max(latG / ssf, rollFraction, oneSideLifted * 1.6)
    );
    this.jackknifeWarning = Math.min(1.5, Math.abs(this.yawA.angle) / this.yawA.limit);
  }

  /**
   * Lateral acceleration of the loaded trailer, m/s^2, taken from the lateral
   * force the tires are actually generating rather than from a steady-state
   * v*yawRate approximation that goes wrong the moment the rig is transient.
   */
  lateralAcceleration() {
    const b = this.trailer.body;
    b.localToWorldDir(LOCAL_RIGHT, _tmp);
    return b.specificForce.dot(_tmp);
  }

  /** Per-axle scale weights, the way a permit officer would read them. */
  axleWeights() {
    const groups = [];
    const push = (label, wheels) => {
      const n = wheels.reduce((s, w) => s + w.load, 0);
      groups.push({ label, lb: n * N_TO_LB, n });
    };
    push('Steer', this.tractor.wheels.filter((w) => w.position.z > 0));
    push('Drives', this.tractor.wheels.filter((w) => w.position.z < 0));
    push('Jeep', this.jeep.wheels);
    push('Lowboy', this.trailer.wheels);
    return groups;
  }

  get grossWeightLb() {
    return this.units.reduce((s, u) => s + u.body.mass, 0) * 2.20462;
  }

  get speedMph() {
    return this.tractor.forwardSpeed * 2.23694;
  }

  updateTelemetry() {
    this.telemetry = {
      speedMph: this.speedMph,
      rpm: this.powertrain.rpm,
      gear: this.powertrain.gearLabel,
      psi: this.air.psi,
      articulation: this.yawA.angle,
      trailerArticulation: this.yawB.angle,
      rollover: this.rolloverWarning,
      jackknife: this.jackknifeWarning,
      hitchLoadA: this.hitchA.impulse.length(),
      brakeTempC: Math.max(...this.units.flatMap((u) => u.wheels.map((w) => w.brake.tempC))),
    };
  }

  /**
   * Places the whole combination at a position and heading, at rest.
   *
   * Each unit is seated relative to the road surface directly beneath it rather
   * than to a flat y=0 plane. Without that, the camber alone leaves the wheels
   * buried several centimetres into the pavement, and on a rig this heavy a
   * few centimetres of extra spring compression is tens of tonnes of phantom
   * axle load.
   */
  placeAt(position, heading, ground = null) {
    const offsets = [0, -4.30, -10.90];
    const rideHeights = [1.182, 0.992, this.trailer.comHeight];
    const dir = new Vector3(Math.sin(heading), 0, Math.cos(heading));

    this.units.forEach((unit, i) => {
      unit.body.position.copy(position).addScaledVector(dir, offsets[i]);
      const surfaceY = ground
        ? ground.sample(unit.body.position.x, unit.body.position.z).height
        : 0;
      unit.body.position.y = surfaceY + rideHeights[i];
      unit.body.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), heading);
      unit.body.velocity.set(0, 0, 0);
      unit.body.angularVelocity.set(0, 0, 0);
      unit.body.updateInertiaWorld();
      unit.wheels.forEach((w) => { w.spin = 0; w.lastLength = w.restLength; });
    });
  }
}
