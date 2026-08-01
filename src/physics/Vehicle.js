import { Vector3 } from 'three';
import { RigidBody } from './RigidBody.js';
import { tireForce, slipRatio, slipAngle, TRUCK_TIRE } from './Tire.js';
import { BrakeGroup } from './Brakes.js';

const _up = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _mount = new Vector3();
const _contact = new Vector3();
const _vel = new Vector3();
const _force = new Vector3();
const _tmp = new Vector3();
const _n = new Vector3();

const LOCAL_UP = new Vector3(0, 1, 0);
const LOCAL_FWD = new Vector3(0, 0, 1);
const LOCAL_RIGHT = new Vector3(1, 0, 0);

/**
 * One wheel: a raycast suspension strut, a tire, and a brake.
 *
 * Positions are in the parent unit's local frame, with +Z forward, +X right and
 * +Y up.
 */
export class Wheel {
  constructor({
    position,
    radius = 0.512,
    width = 0.30,
    steerable = false,
    driven = false,
    tandemSteer = false,
    dual = false,
    tire = TRUCK_TIRE,
    restLength = 0.30,
    stiffness = 480000,   // N/m, per wheel
    damping = 28000,      // N s/m
    maxTravel = 0.22,
    brake = null,
    brakeShare = 1,
    liftable = false,
  }) {
    this.position = position.clone();
    this.radius = radius;
    this.width = width;
    this.steerable = steerable;
    this.tandemSteer = tandemSteer;
    this.driven = driven;
    this.dual = dual;
    this.tire = tire;
    this.restLength = restLength;
    this.stiffness = stiffness;
    this.damping = damping;
    this.maxTravel = maxTravel;
    this.brake = brake || new BrakeGroup();
    this.brakeShare = brakeShare;
    this.liftable = liftable;
    this.lifted = false;

    // State
    this.steerAngle = 0;
    this.spin = 0;            // rad/s
    this.spinAngle = 0;       // for rendering
    this.compression = 0;     // 0..1
    this.lastLength = restLength;
    this.grounded = false;
    this.load = 0;            // N, vertical
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.saturation = 0;
    this.contactPoint = new Vector3();
    this.contactNormal = new Vector3(0, 1, 0);
    this.inertia = dual ? 32 : 18; // kg m^2, wheel + drum

    // Rotational inertia of the engine and gearbox seen at this wheel, set by
    // the powertrain each step. Through a deep gear the engine's own inertia is
    // multiplied by the square of the ratio, so it utterly dominates the
    // wheel's -- which is exactly why a loaded truck in a crawler gear feeds
    // torque in smoothly instead of instantly spinning the tires.
    this.drivelineInertia = 0;

    this.longForce = 0;
    this.latForce = 0;
  }

  /** Total rotational inertia resisting a change in this wheel's speed. */
  get effectiveInertia() {
    return this.inertia + this.drivelineInertia;
  }

  /** Effective vertical stiffness, doubled for dual (tandem) tire positions. */
  get effectiveStiffness() {
    return this.dual ? this.stiffness * 1.55 : this.stiffness;
  }
}

/**
 * A single articulated unit -- tractor, jeep dolly, or lowboy -- consisting of a
 * rigid body and its wheels.
 */
export class VehicleUnit {
  constructor({ name, mass, size, wheels, comOffset = new Vector3(), position = new Vector3() }) {
    this.name = name;
    this.size = size.clone();
    this.comOffset = comOffset.clone();

    const inertia = RigidBody.boxInertia(mass, size.x, size.y, size.z);
    this.body = new RigidBody({ mass, inertia, position });
    this.wheels = wheels;

    this.antiRollStiffness = 260000; // N m/rad between paired wheels
    this.surfaceGripOverride = null;

    // Points on the underside of the chassis, in local coordinates. If any of
    // these touch the road the unit is dragging: on a lowboy with a 22-inch
    // deck that is a real hazard at every driveway lip and railroad crossing,
    // and it is also the backstop that stops a bottomed-out unit sinking
    // through the world.
    this.chassisPoints = [];
    this.chassisContact = 0;

    // Aerodynamics. `dragArea` is Cd*A in square metres; `sideArea` is the
    // slab side of the unit, which is what a crosswind pushes on. The centre of
    // pressure sits above the centre of mass, so a gust does not just shove the
    // rig sideways -- it rolls it, which is why these moves shut down for wind.
    this.dragArea = 0;
    this.sideArea = 0;
    this.pressureCenterHeight = 1.0;
  }

  /**
   * Applies aerodynamic drag and crosswind loading.
   * @param wind world-space wind velocity, m/s
   */
  applyAerodynamics(wind) {
    if (this.dragArea <= 0 && this.sideArea <= 0) return;
    const RHO = 1.225;
    const body = this.body;

    // Airflow relative to the vehicle.
    _vel.copy(body.velocity).sub(wind);
    const speed = _vel.length();
    if (speed < 0.1) return;

    body.localToWorldDir(LOCAL_FWD, _fwd).normalize();
    body.localToWorldDir(LOCAL_RIGHT, _right).normalize();
    const vLong = _vel.dot(_fwd);
    const vLat = _vel.dot(_right);

    _force.set(0, 0, 0);
    _force.addScaledVector(_fwd, -0.5 * RHO * this.dragArea * vLong * Math.abs(vLong));
    _force.addScaledVector(_right, -0.5 * RHO * this.sideArea * vLat * Math.abs(vLat));

    // Applied at the centre of pressure rather than the centre of mass.
    body.localToWorld(_tmp.set(0, this.pressureCenterHeight, 0), _contact);
    body.applyForce(_force, _contact);
  }

  /** Total vertical load currently carried by the tires, in newtons. */
  get axleLoad() {
    return this.wheels.reduce((s, w) => s + w.load, 0);
  }

  /**
   * Runs suspension, tire and wheel-spin physics for every wheel on this unit.
   *
   * @param dt        timestep
   * @param ground    object exposing sample(x, z) -> { height, normal, grip }
   * @param driveTorque total torque to split across driven wheels, Nm at wheel
   * @param brakeDemand 0..1
   * @param airPsi    supply pressure for the brake groups
   */
  update(dt, ground, driveTorque, brakeDemand, airPsi) {
    const body = this.body;
    body.localToWorldDir(LOCAL_UP, _up).normalize();

    const drivenWheels = this.wheels.filter((w) => w.driven && !w.lifted);
    const perWheelDrive = drivenWheels.length ? driveTorque / drivenWheels.length : 0;

    // --- Suspension pass -----------------------------------------------------
    for (const w of this.wheels) {
      if (w.lifted) {
        w.grounded = false;
        w.load = 0;
        w.compression = 0;
        continue;
      }

      body.localToWorld(w.position, _mount);
      const sample = ground.sample(_mount.x, _mount.z);
      _n.copy(sample.normal);

      // Distance from the strut mount straight down to the road surface. Using
      // the body's own up axis keeps the strut attached to the chassis as it
      // rolls, which is what produces load transfer in a corner.
      const groundY = sample.height;
      const drop = _mount.y - groundY;
      const targetLength = drop - w.radius;

      if (targetLength > w.restLength + w.maxTravel) {
        // Wheel is off the ground: droop to full extension, no force.
        w.grounded = false;
        w.load = 0;
        w.compression = 0;
        w.lastLength = w.restLength + w.maxTravel;
        w.contactPoint.copy(_mount).addScaledVector(_up, -(w.lastLength + w.radius));
        w.contactNormal.copy(_n);
        // Spin decays from bearing drag alone.
        w.spin *= Math.exp(-0.4 * dt);
        continue;
      }

      const length = Math.max(w.restLength - w.maxTravel, targetLength);
      const compressionDist = w.restLength - length;
      w.compression = Math.max(0, Math.min(1, compressionDist / (w.maxTravel * 2)));

      // Strut velocity, clamped: a wheel dropping into a pothole or landing
      // after a crest would otherwise produce a single enormous damper spike.
      const vel = Math.max(-4, Math.min(4, (w.lastLength - length) / dt));
      w.lastLength = length;

      let springForce = w.effectiveStiffness * compressionDist + w.damping * vel;

      // Bump stop: the last few centimetres of travel get very stiff, which is
      // what a fully loaded air bag on the stops actually does.
      if (compressionDist > w.maxTravel) {
        springForce += (compressionDist - w.maxTravel) * w.effectiveStiffness * 6;
      }
      springForce = Math.max(0, springForce);

      w.grounded = true;
      w.load = springForce;
      w.contactPoint.copy(_mount).addScaledVector(_up, -(length + w.radius));
      w.contactNormal.copy(_n);
    }

    this.applyAntiRoll();

    // --- Tire pass -----------------------------------------------------------
    for (const w of this.wheels) {
      if (!w.grounded || w.lifted) {
        w.longForce = 0;
        w.latForce = 0;
        w.slipRatio = 0;
        w.slipAngle = 0;
        w.saturation = 0;
        // Freewheeling wheel still responds to drive and brake torque.
        const brakeT = w.brake.torque() * w.brakeShare;
        const I = w.effectiveInertia;
        let spin = w.spin + (perWheelDrive * (w.driven ? 1 : 0) / I) * dt;
        const decel = (brakeT / I) * dt;
        spin = Math.abs(spin) <= decel ? 0 : spin - Math.sign(spin) * decel;
        w.spin = spin;
        w.spinAngle += w.spin * dt;
        continue;
      }

      // Contact patch basis, projected onto the road surface.
      _n.copy(w.contactNormal);
      body.localToWorldDir(LOCAL_FWD, _fwd);
      if (w.steerAngle !== 0) {
        _fwd.applyAxisAngle(_up, w.steerAngle);
      }
      _fwd.addScaledVector(_n, -_fwd.dot(_n));
      if (_fwd.lengthSq() < 1e-8) continue;
      _fwd.normalize();
      _right.copy(_n).cross(_fwd).normalize().negate();

      body.getPointVelocity(w.contactPoint, _vel);
      const vLong = _vel.dot(_fwd);
      const vLat = _vel.dot(_right);

      const kappa = slipRatio(w.spin * w.radius, vLong);
      const alpha = slipAngle(vLong, vLat);
      w.slipRatio = kappa;
      w.slipAngle = alpha;

      const grip = this.surfaceGripOverride ?? ground.sample(w.contactPoint.x, w.contactPoint.z).grip;

      // A dual is two tires sharing the position's load. Each carries half, so
      // each sits lower on the load-sensitivity curve and keeps more of its
      // friction coefficient -- which is the entire reason duals are fitted.
      const patchScale = w.dual ? 2 : 1;
      const res = tireForce(w.tire, kappa, alpha, w.load / patchScale, grip);
      w.saturation = res.saturation;

      const Fx = res.Fx * patchScale;
      const Fy = res.Fy * patchScale;

      w.longForce = Fx;
      w.latForce = Fy;

      // Vertical (suspension) plus horizontal (tire) forces at the contact patch.
      _force.copy(_up).multiplyScalar(w.load);
      _force.addScaledVector(_fwd, Fx);
      _force.addScaledVector(_right, Fy);
      body.applyForce(_force, w.contactPoint);

      // --- Wheel spin dynamics ---
      const brakeT = w.brake.torque() * w.brakeShare;
      const reaction = -Fx * w.radius;
      const drive = w.driven ? perWheelDrive : 0;

      // Rolling resistance is a moment, not a contact force: it comes from the
      // pressure in the contact patch sitting ahead of the axle centreline.
      // Modelling it as a force at the patch would feed straight back into the
      // wheel's own spin equation and cancel itself out.
      const rrTorque = w.tire.rollingResistance * w.load * w.radius;
      const I = w.effectiveInertia;

      let spin = w.spin + ((drive + reaction) / I) * dt;
      const rrDecel = (rrTorque / I) * dt;
      if (Math.abs(spin) <= rrDecel) spin = 0;
      else spin -= Math.sign(spin) * rrDecel;

      // Brake torque opposes rotation but must not spin the wheel backwards
      // within a step, which would chatter. Clamping to zero is the standard fix.
      const decel = (brakeT / I) * dt;
      if (Math.abs(spin) <= decel) {
        spin = 0;
        // With the wheel locked the tire is sliding; heat goes into the drum.
        w.brake.addHeat(dt, Math.abs(Fx * vLong) * 0.35, Math.abs(vLong));
      } else {
        spin -= Math.sign(spin) * decel;
        w.brake.addHeat(dt, Math.abs(brakeT * spin), Math.abs(vLong));
      }
      w.spin = spin;
      w.spinAngle += w.spin * dt;
    }

    this.resolveChassisContacts(dt, ground);
  }

  /**
   * Stops the chassis from passing through the road when the suspension has run
   * out of travel, and reports it when the underside is dragging.
   */
  resolveChassisContacts(dt, ground) {
    this.chassisContact = 0;
    if (!this.chassisPoints.length) return;

    for (const p of this.chassisPoints) {
      this.body.localToWorld(p, _contact);
      const sample = ground.sample(_contact.x, _contact.z);
      const depth = sample.height - _contact.y;
      if (depth <= 0) continue;

      this.chassisContact = Math.max(this.chassisContact, depth);

      this.body.getPointVelocity(_contact, _vel);
      const closing = Math.max(0, -_vel.dot(sample.normal));

      // Stiff, heavily damped contact. Scaled by mass so it behaves the same
      // under an empty jeep and a loaded lowboy.
      const k = this.body.mass * 900;
      const c = this.body.mass * 90;
      const mag = Math.min(k * depth + c * closing, this.body.mass * 260);
      _force.copy(sample.normal).multiplyScalar(mag);
      this.body.applyForce(_force, _contact);

      // Scraping steel on asphalt kills speed quickly.
      _tmp.copy(this.body.velocity);
      _tmp.addScaledVector(sample.normal, -_tmp.dot(sample.normal));
      if (_tmp.lengthSq() > 1e-6) {
        _force.copy(_tmp).normalize().multiplyScalar(-mag * 0.55);
        this.body.applyForce(_force, _contact);
      }
    }
  }

  /**
   * Anti-roll bars couple left and right wheels on the same axle, transferring
   * load across the vehicle. Without this a tall load feels far too willing to
   * lean, and the roll threshold ends up unrealistically low.
   */
  applyAntiRoll() {
    const byAxle = new Map();
    for (const w of this.wheels) {
      const key = w.position.z.toFixed(3);
      if (!byAxle.has(key)) byAxle.set(key, []);
      byAxle.get(key).push(w);
    }

    for (const pair of byAxle.values()) {
      if (pair.length !== 2) continue;
      const [a, b] = pair;
      if (!a.grounded && !b.grounded) continue;

      // Compression difference across the axle. The bar loads the compressed
      // (outer) wheel further and unloads the inner one -- which is exactly why
      // a stiffer bar costs that axle grip.
      const travelDiff = (a.restLength - a.lastLength) - (b.restLength - b.lastLength);
      let transfer = travelDiff * this.antiRollStiffness * 0.5;

      // A bar moves load across the axle; it cannot create any. Clamping the
      // transfer to what the unloaded side actually has keeps the total
      // vertical force equal to the weight on that axle -- without this, a
      // clamp at zero on one side quietly adds load to the vehicle every step,
      // and the rig ends up supporting more than it weighs.
      transfer = Math.max(-a.load, Math.min(b.load, transfer));

      // Only the loads are adjusted here. The tire pass applies each wheel's
      // load as a force; applying the transfer separately as well would count
      // it twice and make the vehicle roll unstably.
      a.load += transfer;
      b.load -= transfer;
    }
  }

  /** Forward speed along the unit's own axis, m/s. */
  get forwardSpeed() {
    this.body.localToWorldDir(LOCAL_FWD, _tmp);
    return this.body.velocity.dot(_tmp);
  }

  /**
   * Roll angle in radians, measured about the unit's own longitudinal axis so
   * that it stays correct at any heading. Positive is leaning to the right.
   */
  get rollAngle() {
    this.body.localToWorldDir(LOCAL_RIGHT, _tmp);
    return Math.asin(Math.max(-1, Math.min(1, -_tmp.y)));
  }
}
