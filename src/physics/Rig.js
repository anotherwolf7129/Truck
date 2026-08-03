import { Vector3 } from 'three';
import { VehicleUnit, Wheel } from './Vehicle.js';
import { BallJoint, RollCoupling, YawLimit } from './Constraints.js';
import { Powertrain } from './Powertrain.js';
import { AirSystem, BrakeGroup } from './Brakes.js';
import { TRUCK_TIRE, STEER_TIRE } from './Tire.js';
import { getTrailer, resolveTrailer, DEFAULT_TRAILER } from './Trailers.js';

const GRAVITY = new Vector3(0, -9.81, 0);
const LOCAL_FWD = new Vector3(0, 0, 1);
// Right-handed frame, +Y up, rig facing +Z: the driver's right is -X. See the
// note on LOCAL_RIGHT in Vehicle.js.
const LOCAL_RIGHT = new Vector3(-1, 0, 0);
const _tmp = new Vector3();

const N_TO_LB = 0.2248089431;

/**
 * What one extra prime mover can put on the road, newtons.
 *
 * A tractor's drive tandem carries about seventeen tonnes, and a tire can hold
 * roughly its own vertical load in tractive effort before it gives up -- so a
 * push truck is good for something like 110 kN whatever its engine is capable
 * of. This is the cap that stops four engines becoming four times the traction.
 */
const PUSH_TRACTION = 110000;

// Every pivot on the combination sits at this height above the road, which is
// where a real fifth wheel plate lives.
const COUPLING_HEIGHT = 1.329;

/**
 * The complete heavy haul combination: a 6x4 tractor, optionally a jeep dolly,
 * and whichever trailer the yard has put under the load.
 *
 * Separate rigid bodies coupled at pivots is the smallest model that reproduces
 * the behaviour that defines this kind of driving -- the trailer tracking well
 * inside the tractor's path through a corner, the load pushing the drives around
 * under braking, and the slow sway that builds if you correct too fast at speed.
 *
 * What goes behind the tractor is declared in `Trailers.js` rather than written
 * in here, because it is not one trailer: a three-axle step deck, a lowboy on a
 * jeep, a twenty-axle dual-lane platform and a seventy-metre blade cradle are
 * all the same three sentences of geometry with different numbers in them.
 */
export class Rig {
  constructor(options = {}) {
    const base = typeof options.trailer === 'object' && options.trailer
      ? options.trailer
      : getTrailer(options.trailer ?? DEFAULT_TRAILER);
    // `cargo` still overrides whatever the spec carries, so a caller can put a
    // different load on a known trailer without declaring a new one.
    const spec = resolveTrailer(base, options.cargo ?? null);
    this.spec = spec;
    this.cargo = spec.cargo;
    this.loadHeight = spec.loadHeight;
    this.combinationLength = spec.combinationLength;

    this.tractor = this.buildTractor();
    this.jeep = spec.jeep ? this.buildJeep(spec.jeep) : null;
    this.trailer = this.buildTrailer(spec);

    this.units = this.jeep
      ? [this.tractor, this.jeep, this.trailer]
      : [this.tractor, this.trailer];

    // --- Couplings ---------------------------------------------------------
    // Anchor heights put every pivot at the same coupling height, which is where
    // a real fifth wheel sits. See tools/layout.mjs for the static load analysis
    // these positions come from.
    //
    // The chain is built rather than written out, because a combination is two
    // pivots with a jeep in it and one without, and the only thing that changes
    // between them is what the tractor's fifth wheel is picking up.
    this.pivots = [];
    const link = (a, aAnchor, b, bAnchor, { roll, yaw }) => {
      const pivot = {
        ball: new BallJoint(a.body, aAnchor, b.body, bAnchor),
        roll: new RollCoupling(a.body, b.body, { stiffness: roll }),
        yaw: new YawLimit(a.body, b.body, { limit: yaw }),
      };
      this.pivots.push(pivot);
      return pivot;
    };

    const goosenecky = new Vector3(0, COUPLING_HEIGHT - this.trailer.comHeight, spec.couplingZ);
    if (this.jeep) {
      const j = spec.jeep;
      link(this.tractor, new Vector3(0, 0.146, -2.10),
        this.jeep, new Vector3(0, 0.337, j.kingpinZ), { roll: 0.85, yaw: 1.45 });
      // The jeep's rear coupling sits just ahead of its own axles so that a
      // useful share of the deck load carries forward onto the tractor's drives
      // instead of levering the nose light.
      link(this.jeep, new Vector3(0, 0.337, j.fifthWheelZ),
        this.trailer, goosenecky, { roll: 0.88, yaw: 1.30 });
    } else {
      link(this.tractor, new Vector3(0, 0.146, -2.10),
        this.trailer, goosenecky, { roll: 0.86, yaw: 1.40 });
    }

    // Named handles on the ends of the chain: `A` is the pivot behind the cab,
    // which is the one that jackknifes, and `B` is the trailer's own, which is
    // the one the steerman works against. On a combination with no jeep in it
    // they are the same pivot.
    const first = this.pivots[0];
    const last = this.pivots[this.pivots.length - 1];
    this.hitchA = first.ball;
    this.rollA = first.roll;
    this.yawA = first.yaw;
    this.hitchB = last.ball;
    this.rollB = last.roll;
    this.yawB = last.yaw;

    this.constraints = this.pivots.flatMap((p) => [p.ball, p.roll, p.yaw]);
    this.solverIterations = spec.solverIterations;

    // --- Systems -----------------------------------------------------------
    // A dual-lane move has more than one engine on it. The extra prime movers
    // are not simulated as separate bodies -- they are pushing and pulling on
    // the same combination through the same driveline speed -- so they show up
    // as the tractive effort they contribute and nothing else.
    this.powertrain = new Powertrain({ powerUnits: spec.powerUnits });
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
    this.maxTrailerSteer = spec.maxRearSteer;
    // With this on, the rear axle group steers itself against the articulation
    // instead of waiting for the steerman's box. Q and E still override it.
    this.autoTrailerSteer = spec.maxRearSteer > 0;
    this.diffLock = false;

    this.wheelbase = 5.10;
    this.steerTrack = 2.04;
    // Half the trailer's track at its outermost tire line, which is what the
    // rollover threshold is measured against. A dual-lane platform is nearly
    // three metres out to each side and is correspondingly hard to tip over.
    this.trailerHalfTrack = spec.halfTrack;

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

  buildJeep(spec) {
    const mountY = -0.20;
    const wheels = [];
    for (const z of spec.axleZ) {
      for (const side of [-1, 1]) {
        wheels.push(new Wheel({
          position: new Vector3(side * spec.track, mountY, z),
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
      mass: spec.mass,
      size: spec.size,
      wheels,
      position: new Vector3(0, 0.992, this.spec.jeepOffset),
    });
    unit.antiRollStiffness = spec.antiRoll;
    unit.dragArea = 0.5;
    unit.sideArea = spec.size.z * 0.65;
    unit.pressureCenterHeight = 0.4;
    const back = spec.axleZ[spec.axleZ.length - 1] - 0.25;
    unit.chassisPoints = [
      new Vector3(-0.6, -0.55, 1.6), new Vector3(0.6, -0.55, 1.6),
      new Vector3(-0.6, -0.55, back), new Vector3(0.6, -0.55, back),
    ];
    return unit;
  }

  /**
   * Whatever is under the load, built from its spec.
   *
   * The interesting part is that none of the geometry below is written down
   * twice. The suspension mount height is derived from the load's own centre of
   * gravity, the tire lines from the declared track, and the underside contact
   * points from the deck -- so a trailer declared with a metre of extra deck
   * height cannot silently end up with its wheels buried in the road, and one
   * with the load stacked two metres higher gets the rollover threshold that
   * implies rather than the lowboy's.
   */
  buildTrailer(spec) {
    const cargo = spec.cargo;
    const mass = spec.tare + cargo.mass;

    // The load usually dominates the combined centre of gravity, and it usually
    // sits high. This is the single biggest handling factor on the rig: it sets
    // the rollover threshold, and it is why these moves crawl through corners a
    // bobtail tractor would take at forty.
    const comHeight = (cargo.mass * cargo.centerHeight + spec.tare * (spec.deckHeight + 0.35)) / mass;

    const a = spec.axle;
    const staticCompression = 0.047;
    const mountY = -(comHeight - (a.restLength - staticCompression) - a.radius);

    const wheels = [];
    for (const axle of spec.axles) {
      for (const track of spec.tracks) {
        for (const side of [-1, 1]) {
          wheels.push(new Wheel({
            position: new Vector3(side * track, mountY, axle.z),
            dual: true,
            radius: a.radius,
            tire: TRUCK_TIRE,
            restLength: a.restLength,
            stiffness: a.stiffness,
            damping: a.damping,
            maxTravel: a.maxTravel,
            // The rear group steers to shorten the effective off-track through
            // tight corners. On the long trailers it is not an optimisation --
            // nothing gets round a corner without it.
            tandemSteer: !!axle.steer,
            brake: new BrakeGroup({
              maxTorque: a.brakeTorque, thermalMass: a.brakeThermalMass, lag: a.brakeLag,
            }),
            liftable: !!axle.lift,
          }));
        }
      }
    }

    const unit = new VehicleUnit({
      name: 'trailer',
      mass,
      size: new Vector3(spec.bodyWidth, Math.max(cargo.size.y, 1.2), spec.bodyLength),
      wheels,
      position: new Vector3(0, comHeight, spec.trailerOffset),
    });
    unit.comHeight = comHeight;
    unit.deckHeight = spec.deckHeight;
    unit.antiRollStiffness = spec.antiRoll;
    unit.cargo = cargo;

    // The load itself is the aerodynamic problem: several metres of flat,
    // unfaired steel. Cd for a bluff box like this is close to 1.0.
    const frontal = cargo.size.x * cargo.size.y;
    unit.dragArea = frontal * 0.98;
    unit.sideArea = cargo.size.z * cargo.size.y * 0.85;
    unit.pressureCenterHeight = cargo.centerHeight - comHeight;

    // Underside of the deck. On a lowboy this is half a metre off the road and
    // is the lowest point on the whole combination -- the first thing to touch
    // on a crest.
    const deckLocalY = spec.deckHeight - comHeight;
    const halfDeck = spec.deckWidth * 0.5 - 0.2;
    const stations = 4;
    for (let i = 0; i <= stations; i++) {
      const z = spec.deckFrom + ((spec.deckTo - spec.deckFrom) * i) / stations;
      unit.chassisPoints.push(
        new Vector3(-halfDeck, deckLocalY, z),
        new Vector3(halfDeck, deckLocalY, z)
      );
    }
    return unit;
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  /**
   * Ackermann steering: the inside wheel turns more sharply than the outside so
   * both trace the same turn centre. On a long-wheelbase tractor this is very
   * visible at full lock.
   *
   * This is the one place a driver input becomes a wheel angle, so it is also
   * the one place the sign flip lives. `steerInput` is +1 for right because that
   * is what the right arrow key means; a right turn is a negative rotation
   * about +Y (see LOCAL_RIGHT in Vehicle.js), and every steer angle from here
   * down is that raw rotation.
   */
  applySteering(dt) {
    const target = -this.steerInput * this.maxSteerAngle;
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
        // The inner wheel is the one on the side being turned toward. A left
        // turn is a positive angle and the left-hand wheel sits at +X.
        const isInner = Math.sign(w.position.x) === sign;
        w.steerAngle = sign * (isInner ? inner : outer);
      }
    }

    // Trailer rear steer, with self-centring when released.
    const tTarget = this.trailerSteerTarget();
    this.trailerSteerAngle += (tTarget - this.trailerSteerAngle) * Math.min(1, 2.2 * dt);
    for (const w of this.trailer.wheels) {
      if (w.tandemSteer) w.steerAngle = this.trailerSteerAngle;
    }
  }

  /**
   * Where the lowboy's rear axle group is being asked to point, as a rotation
   * about +Y like every other steer angle.
   *
   * Manual first: any input on the steerman's box wins, so grabbing Q or E in
   * the middle of a corner takes the axles off the automatics immediately
   * rather than fighting them.
   */
  trailerSteerTarget() {
    if (Math.abs(this.trailerSteerInput) > 0.02) {
      return -this.trailerSteerInput * this.maxTrailerSteer;
    }
    return this.autoTrailerSteer ? this.steermanAngle() : 0;
  }

  /**
   * The angle a steerman would be holding: the one that stops the lowboy's rear
   * axles cutting inside the tractor's path.
   *
   * For a trailer whose rear axle group is steerable, the rear axles trace the
   * same radius as the gooseneck when they are turned to minus the articulation
   * angle -- the tail is pushed out of the corner by exactly as much as it would
   * otherwise have cut into it. That is a geometric result, not a tuned number,
   * which is why there is no gain on it.
   *
   * Authority fades out with speed. A rear axle group steering itself at road
   * speed does not shorten anything, it just wags the tail of a 212,000 lb load,
   * and the real command-steer boxes lock out for the same reason.
   */
  steermanAngle() {
    const mph = this.speedMph;
    const authority = 1 - Math.max(0, Math.min(1, (mph - 12) / 13));
    if (authority <= 0) return 0;
    const target = -this.yawB.angle * authority;
    return Math.max(-this.maxTrailerSteer, Math.min(this.maxTrailerSteer, target));
  }

  /**
   * The other prime movers on the combination.
   *
   * A dual-lane move is not one truck. There is a second tractor on the drawbar
   * and push trucks on the back, and they are the reason 328 tonnes can be
   * started at all: one 600 hp tractor makes plenty of torque for it in a
   * crawler gear, but a single drive tandem cannot put 200 kN on the road
   * without simply spinning, whatever the engine is doing.
   *
   * So the extras are not modelled as more torque through this tractor's tires.
   * They push through their own, and what each of them can contribute is capped
   * by what a loaded drive tandem can actually hold -- which is why the whole
   * combination still crawls up a six percent grade rather than climbing it like
   * an empty truck.
   */
  applyPushUnits(wheelTorque, wheelRadius) {
    const extra = this.spec.powerUnits - 1;
    if (extra <= 0) return;

    const perUnit = wheelTorque / wheelRadius;
    const limited = Math.max(-PUSH_TRACTION, Math.min(PUSH_TRACTION, perUnit));
    const body = this.trailer.body;
    body.localToWorldDir(LOCAL_FWD, _tmp).normalize().multiplyScalar(limited * extra);
    // At the centre of mass: a push truck on the back and a tractor on the
    // drawbar are pushing and pulling on the same line, and splitting them into
    // a couple that yaws the platform is a detail this model has no business
    // inventing.
    body.applyForce(_tmp, body.position);
    this.pushForce = limited * extra;
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
    const wheelTorque = this.powertrain.update(dt, this.driveWheelOmega(), wheelRadius);

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

    this.applyPushUnits(wheelTorque, wheelRadius);

    // --- Aerodynamics -------------------------------------------------------
    for (const unit of this.units) unit.applyAerodynamics(this.wind);

    // --- Per-unit dynamics --------------------------------------------------
    // A locked inter-axle differential sends torque to the wheels that can use
    // it instead of splitting it evenly into whichever one is already spinning.
    this.tractor.update(dt, ground, wheelTorque, brakeDemand, this.air.psi, this.diffLock);
    for (const unit of this.units) {
      if (unit !== this.tractor) unit.update(dt, ground, 0, brakeDemand, this.air.psi);
    }

    // --- Integrate and solve -----------------------------------------------
    for (const unit of this.units) unit.body.integrateVelocity(dt, GRAVITY);

    for (let i = 0; i < this.solverIterations; i++) {
      for (const p of this.pivots) p.ball.solve(dt);
      for (const p of this.pivots) p.roll.solve();
      for (const p of this.pivots) p.yaw.solve();
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
      const left = w.position.x > 0; // +X is the left-hand side of the deck
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

  /**
   * Per-axle scale weights, the way a permit officer would read them.
   *
   * The lowboy is broken out axle by axle rather than totalled, because on a
   * multi-axle trailer the total is not the number anybody is arguing about --
   * a group can be legal on its total and still be over on one axle, and
   * lifting an axle moves several thousand pounds onto its neighbours in front
   * of you. Each row carries the flags the readout needs to say why an axle is
   * doing something unusual.
   */
  axleWeights() {
    const groups = [];
    const push = (label, wheels, extra = {}) => {
      const n = wheels.reduce((s, w) => s + w.load, 0);
      groups.push({ label, lb: n * N_TO_LB, n, ...extra });
    };
    push('Steer', this.tractor.wheels.filter((w) => w.position.z > 0));
    push('Drives', this.tractor.wheels.filter((w) => w.position.z < 0));
    if (this.jeep) push('Jeep', this.jeep.wheels);

    // Group the trailer's wheels by axle, front to back. A dual-lane platform
    // has four tire lines on each of them, and they are still one axle as far as
    // a scale is concerned.
    const byAxle = new Map();
    for (const w of this.trailer.wheels) {
      const key = w.position.z.toFixed(2);
      if (!byAxle.has(key)) byAxle.set(key, []);
      byAxle.get(key).push(w);
    }
    const label = this.spec.axleLabel ?? 'Axle';
    [...byAxle.values()]
      .sort((a, b) => b[0].position.z - a[0].position.z)
      .forEach((wheels, i) => {
        push(`${label} ${i + 1}`, wheels, {
          lifted: wheels.every((w) => w.lifted),
          steered: wheels.some((w) => w.tandemSteer),
        });
      });
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
    const offsets = this.jeep
      ? [0, this.spec.jeepOffset, this.spec.trailerOffset]
      : [0, this.spec.trailerOffset];
    const rideHeights = this.jeep
      ? [1.182, 0.992, this.trailer.comHeight]
      : [1.182, this.trailer.comHeight];
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
