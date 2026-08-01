import { Vector3, Matrix3 } from 'three';
import { skew } from './RigidBody.js';

const _rA = new Vector3();
const _rB = new Vector3();
const _pA = new Vector3();
const _pB = new Vector3();
const _vA = new Vector3();
const _vB = new Vector3();
const _vrel = new Vector3();
const _bias = new Vector3();
const _imp = new Vector3();
const _axis = new Vector3();
const _tmp = new Vector3();
const _fa = new Vector3();
const _fb = new Vector3();
const _sA = new Matrix3();
const _sB = new Matrix3();
const _MA = new Matrix3();
const _MB = new Matrix3();
const _K = new Matrix3();

const FORWARD = new Vector3(0, 0, 1);

function addScaledIdentity(m, s) {
  const e = m.elements;
  e[0] += s; e[4] += s; e[8] += s;
  return m;
}

/**
 * A 3-DOF point-to-point (ball socket) constraint between two rigid bodies.
 *
 * This is the fifth wheel coupling a tractor to a jeep dolly, and the gooseneck
 * coupling the jeep to the lowboy. The joint is free in all three rotations;
 * roll and yaw are then restrained separately by RollCoupling and YawLimit so
 * that each pivot behaves like real hardware instead of a frictionless ball.
 */
export class BallJoint {
  /**
   * @param bodyA first body
   * @param anchorA joint position in bodyA's local frame
   * @param bodyB second body
   * @param anchorB joint position in bodyB's local frame
   */
  constructor(bodyA, anchorA, bodyB, anchorB, { beta = 0.25, maxForce = Infinity } = {}) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.anchorA = anchorA.clone();
    this.anchorB = anchorB.clone();
    this.beta = beta;       // Baumgarte positional feedback
    this.maxForce = maxForce;
    this.impulse = new Vector3();
    this.slop = 0.002;      // metres of positional error tolerated before correction
    this.maxBias = 2.0;     // m/s cap on positional correction velocity
  }

  /** Current world position of each side of the joint. */
  worldAnchors(outA, outB) {
    this.bodyA.localToWorld(this.anchorA, outA);
    this.bodyB.localToWorld(this.anchorB, outB);
  }

  solve(dt) {
    const A = this.bodyA;
    const B = this.bodyB;

    this.worldAnchors(_pA, _pB);
    _rA.copy(_pA).sub(A.position);
    _rB.copy(_pB).sub(B.position);

    // K = (mA^-1 + mB^-1) I - skew(rA) IA^-1 skew(rA) - skew(rB) IB^-1 skew(rB)
    skew(_rA, _sA);
    skew(_rB, _sB);

    _MA.copy(_sA).multiply(A.invInertiaWorld).multiply(_sA);
    _MB.copy(_sB).multiply(B.invInertiaWorld).multiply(_sB);

    const ke = _K.elements;
    const ma = _MA.elements;
    const mb = _MB.elements;
    for (let i = 0; i < 9; i++) ke[i] = -ma[i] - mb[i];
    addScaledIdentity(_K, A.invMass + B.invMass);

    // Relative velocity at the joint.
    A.getPointVelocity(_pA, _vA);
    B.getPointVelocity(_pB, _vB);
    _vrel.copy(_vB).sub(_vA);

    // Baumgarte stabilisation pulls the anchors back together over time. The
    // correction velocity is capped so that a large positional error -- a badly
    // placed spawn, or a unit shoved hard by a collision -- eases back together
    // instead of firing the whole combination into the air.
    _bias.copy(_pB).sub(_pA);
    const err = _bias.length();
    if (err > this.slop) {
      const rate = Math.min((this.beta / dt) * ((err - this.slop) / err), this.maxBias / err);
      _bias.multiplyScalar(rate);
    } else {
      _bias.set(0, 0, 0);
    }

    _imp.copy(_vrel).add(_bias).negate();
    _imp.applyMatrix3(_K.invert());

    const maxImpulse = this.maxForce * dt;
    if (Number.isFinite(maxImpulse) && _imp.length() > maxImpulse) {
      _imp.setLength(maxImpulse);
    }

    B.applyImpulse(_imp, _pB);
    _tmp.copy(_imp).negate();
    A.applyImpulse(_tmp, _pA);
    this.impulse.copy(_imp);
  }

  /** Magnitude of the force currently carried by this hitch, in newtons. */
  forceMagnitude(dt) {
    return this.impulse.length() / dt;
  }
}

/**
 * Restrains relative roll between two coupled units about a shared longitudinal
 * axis.
 *
 * A fifth wheel is free in pitch and yaw but transmits roll almost rigidly --
 * this is why a loaded trailer can roll a tractor over onto its side rather than
 * simply tipping on its own. `stiffness` in [0,1] is how much of the relative
 * roll velocity is cancelled per solve.
 */
export class RollCoupling {
  constructor(bodyA, bodyB, { stiffness = 0.9, localAxis = new Vector3(0, 0, 1) } = {}) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.stiffness = stiffness;
    this.localAxis = localAxis.clone();
  }

  solve() {
    const A = this.bodyA;
    const B = this.bodyB;
    A.localToWorldDir(this.localAxis, _axis).normalize();

    const relOmega = _tmp.copy(B.angularVelocity).sub(A.angularVelocity);
    const rollRate = relOmega.dot(_axis);
    if (rollRate === 0) return;

    // Effective inertia about the axis for the pair.
    const ia = _vA.copy(_axis).applyMatrix3(A.invInertiaWorld).dot(_axis);
    const ib = _vB.copy(_axis).applyMatrix3(B.invInertiaWorld).dot(_axis);
    const denom = ia + ib;
    if (denom <= 1e-9) return;

    const lambda = (-rollRate * this.stiffness) / denom;
    _imp.copy(_axis).multiplyScalar(lambda);
    B.applyAngularImpulse(_imp);
    A.applyAngularImpulse(_imp.negate());
  }
}

/**
 * A hard stop on the articulation (yaw) angle at a hitch.
 *
 * On a real tractor the trailer physically contacts the cab or frame at roughly
 * 90 degrees; past that the rig is jackknifed and cannot be straightened by
 * steering alone. Modelling the stop is what makes a jackknife a recoverable-or-
 * not situation rather than the trailer spinning freely around the kingpin.
 */
export class YawLimit {
  constructor(bodyA, bodyB, { limit = Math.PI * 0.5, stiffness = 0.6 } = {}) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.limit = limit;
    this.stiffness = stiffness;
    this.angle = 0;
  }

  /** Signed articulation angle between the two units, in radians. */
  articulation() {
    this.bodyA.localToWorldDir(FORWARD, _fa);
    this.bodyB.localToWorldDir(FORWARD, _fb);
    _fa.y = 0; _fb.y = 0;
    if (_fa.lengthSq() < 1e-9 || _fb.lengthSq() < 1e-9) return 0;
    _fa.normalize(); _fb.normalize();
    const cross = _fa.x * _fb.z - _fa.z * _fb.x;
    return Math.atan2(cross, _fa.dot(_fb));
  }

  solve() {
    const a = this.articulation();
    this.angle = a;
    const over = Math.abs(a) - this.limit;
    if (over <= 0) return;

    const A = this.bodyA;
    const B = this.bodyB;
    _axis.set(0, Math.sign(a), 0);

    const relYaw = _tmp.copy(B.angularVelocity).sub(A.angularVelocity).dot(_axis);
    if (relYaw <= 0) return; // already unwinding, let it

    const ia = _vA.copy(_axis).applyMatrix3(A.invInertiaWorld).dot(_axis);
    const ib = _vB.copy(_axis).applyMatrix3(B.invInertiaWorld).dot(_axis);
    const denom = ia + ib;
    if (denom <= 1e-9) return;

    const lambda = (-relYaw * this.stiffness) / denom;
    _imp.copy(_axis).multiplyScalar(lambda);
    B.applyAngularImpulse(_imp);
    A.applyAngularImpulse(_imp.negate());
  }
}
