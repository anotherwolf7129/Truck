import { Vector3, Quaternion, Matrix3, Matrix4 } from 'three';

const _v = new Vector3();
const _r = new Vector3();
const _q = new Quaternion();
const _rot = new Matrix3();
const _rotM4 = new Matrix4();
const _prev = new Vector3();

/**
 * Sets `out` to the skew-symmetric matrix of `v`, i.e. the matrix S such that
 * S * x === v cross x. Used to build constraint effective-mass matrices.
 */
export function skew(v, out = new Matrix3()) {
  out.set(0, -v.z, v.y, v.z, 0, -v.x, -v.y, v.x, 0);
  return out;
}

/**
 * A 6-DOF rigid body integrated with semi-implicit Euler.
 *
 * Vehicle units (tractor, jeep dolly, lowboy) are each one of these; they are
 * coupled by the constraints in Constraints.js rather than being welded into a
 * single body, which is what produces real articulated behaviour -- off-tracking
 * through corners, trailer sway, and the jackknife failure mode.
 *
 * Everything is SI: metres, kilograms, seconds, newtons, radians.
 */
export class RigidBody {
  constructor({ mass = 1, inertia = new Vector3(1, 1, 1), position = new Vector3() } = {}) {
    this.position = position.clone();
    this.quaternion = new Quaternion();

    this.velocity = new Vector3();
    this.angularVelocity = new Vector3();

    this.force = new Vector3();
    this.torque = new Vector3();

    this.acceleration = new Vector3();
    this.specificForce = new Vector3();

    // Inertia is stored as the diagonal of the body-local inertia tensor. Every
    // body here is roughly a box about its principal axes, so the off-diagonal
    // terms are small enough to ignore.
    this.inertiaLocal = inertia.clone();
    this.invInertiaLocal = new Vector3();

    this.invInertiaWorld = new Matrix3();
    this.linearDamping = 0.0;
    this.angularDamping = 0.02;

    this.setMass(mass);
    this.updateInertiaWorld();
  }

  setMass(mass) {
    this.mass = mass;
    this.invMass = mass > 0 ? 1 / mass : 0;
    this.invInertiaLocal.set(
      this.inertiaLocal.x > 0 ? 1 / this.inertiaLocal.x : 0,
      this.inertiaLocal.y > 0 ? 1 / this.inertiaLocal.y : 0,
      this.inertiaLocal.z > 0 ? 1 / this.inertiaLocal.z : 0
    );
    return this;
  }

  setInertia(inertia) {
    this.inertiaLocal.copy(inertia);
    this.setMass(this.mass);
    this.updateInertiaWorld();
    return this;
  }

  /**
   * Inertia tensor of a solid box, about its own centre. Bodies here are
   * approximated as boxes of the given full extents.
   */
  static boxInertia(mass, sx, sy, sz) {
    const k = mass / 12;
    return new Vector3(
      k * (sy * sy + sz * sz),
      k * (sx * sx + sz * sz),
      k * (sx * sx + sy * sy)
    );
  }

  /** Recomputes the world-space inverse inertia: R * I_local^-1 * R^T. */
  updateInertiaWorld() {
    _rotM4.makeRotationFromQuaternion(this.quaternion);
    _rot.setFromMatrix4(_rotM4);
    const e = _rot.elements; // column-major: e[col*3 + row]
    const ix = this.invInertiaLocal.x;
    const iy = this.invInertiaLocal.y;
    const iz = this.invInertiaLocal.z;

    // M = R * diag(i) * R^T. Scale each column of R by the matching inverse
    // inertia term, then multiply by R^T.
    const a0 = e[0] * ix, a1 = e[1] * ix, a2 = e[2] * ix;
    const a3 = e[3] * iy, a4 = e[4] * iy, a5 = e[5] * iy;
    const a6 = e[6] * iz, a7 = e[7] * iz, a8 = e[8] * iz;

    this.invInertiaWorld.set(
      a0 * e[0] + a3 * e[3] + a6 * e[6],
      a0 * e[1] + a3 * e[4] + a6 * e[7],
      a0 * e[2] + a3 * e[5] + a6 * e[8],

      a1 * e[0] + a4 * e[3] + a7 * e[6],
      a1 * e[1] + a4 * e[4] + a7 * e[7],
      a1 * e[2] + a4 * e[5] + a7 * e[8],

      a2 * e[0] + a5 * e[3] + a8 * e[6],
      a2 * e[1] + a5 * e[4] + a8 * e[7],
      a2 * e[2] + a5 * e[5] + a8 * e[8]
    );
    return this;
  }

  localToWorldDir(v, out = new Vector3()) {
    return out.copy(v).applyQuaternion(this.quaternion);
  }

  worldToLocalDir(v, out = new Vector3()) {
    return out.copy(v).applyQuaternion(_q.copy(this.quaternion).invert());
  }

  localToWorld(v, out = new Vector3()) {
    return out.copy(v).applyQuaternion(this.quaternion).add(this.position);
  }

  worldToLocal(v, out = new Vector3()) {
    return out.copy(v).sub(this.position).applyQuaternion(_q.copy(this.quaternion).invert());
  }

  /** Velocity of the material point currently at world position `p`. */
  getPointVelocity(p, out = new Vector3()) {
    _r.copy(p).sub(this.position);
    return out.copy(this.angularVelocity).cross(_r).add(this.velocity);
  }

  /** Accumulates a world-space force applied at a world-space point. */
  applyForce(f, p) {
    this.force.add(f);
    _r.copy(p).sub(this.position);
    this.torque.add(_v.copy(_r).cross(f));
    return this;
  }

  applyForceAtCenter(f) {
    this.force.add(f);
    return this;
  }

  applyTorque(t) {
    this.torque.add(t);
    return this;
  }

  /** Applies an instantaneous world-space impulse at a world-space point. */
  applyImpulse(j, p) {
    this.velocity.addScaledVector(j, this.invMass);
    _r.copy(p).sub(this.position);
    _v.copy(_r).cross(j).applyMatrix3(this.invInertiaWorld);
    this.angularVelocity.add(_v);
    return this;
  }

  applyAngularImpulse(j) {
    this.angularVelocity.add(_v.copy(j).applyMatrix3(this.invInertiaWorld));
    return this;
  }

  integrateVelocity(dt, gravity) {
    if (this.invMass === 0) return this;
    _prev.copy(this.velocity);

    this.velocity.addScaledVector(this.force, this.invMass * dt);
    this.velocity.addScaledVector(gravity, dt);

    _v.copy(this.torque).applyMatrix3(this.invInertiaWorld).multiplyScalar(dt);
    this.angularVelocity.add(_v);

    // Exponential damping keeps the solver from accumulating energy over long
    // sessions; the coefficients are small enough not to feel like drag.
    const ld = Math.exp(-this.linearDamping * dt);
    const ad = Math.exp(-this.angularDamping * dt);
    this.velocity.multiplyScalar(ld);
    this.angularVelocity.multiplyScalar(ad);

    // Specific force ("g-force"): the acceleration the body feels, excluding
    // gravity. This is what tips a load over, and what an accelerometer bolted
    // to the trailer would read.
    this.acceleration.copy(this.velocity).sub(_prev).multiplyScalar(1 / dt);
    this.specificForce.copy(this.acceleration).sub(gravity);

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    return this;
  }

  integratePosition(dt) {
    if (this.invMass === 0) return this;
    this.position.addScaledVector(this.velocity, dt);

    // q' = q + 0.5 * omega_quat * q * dt
    _q.set(this.angularVelocity.x, this.angularVelocity.y, this.angularVelocity.z, 0);
    _q.multiply(this.quaternion);
    this.quaternion.x += 0.5 * _q.x * dt;
    this.quaternion.y += 0.5 * _q.y * dt;
    this.quaternion.z += 0.5 * _q.z * dt;
    this.quaternion.w += 0.5 * _q.w * dt;
    this.quaternion.normalize();

    this.updateInertiaWorld();
    return this;
  }
}
