import { Vector3 } from 'three';

const clamp = (v, limit) => Math.max(-limit, Math.min(limit, v));

/**
 * Pose of a kinematic vehicle that lives on the route.
 *
 * Traffic and escorts are driven by an arc length and a lane offset rather than
 * by the full vehicle physics. The naive way to render that -- point the body
 * straight down the centreline and translate the lane offset -- makes every lane
 * change and shoulder pull-off look like a box being slid sideways, because
 * nothing in the transform ever reflects the lateral motion.
 *
 * A real car yaws into the move before it gets there, its front wheels stay
 * turned for as long as it is turning, and it pitches with the road under it.
 * All three are derivable from the motion the AI already produced, so this takes
 * the arc length, lane offset and speed and hands back a pose that reads as
 * driving rather than as translation.
 */
export class RoadPose {
  constructor(route, {
    direction = 1, wheelRadius = 0.34, wheelbase = 2.85, maxSteer = 0.62, response = 6,
  } = {}) {
    this.route = route;
    this.direction = direction;
    this.wheelRadius = wheelRadius;
    this.wheelbase = wheelbase;
    this.maxSteer = maxSteer;
    this.response = response;

    this.position = new Vector3();
    this.heading = 0;        // world yaw, radians
    this.pitch = 0;          // nose up/down with the grade
    this.slip = 0;           // yaw relative to the road, from lateral motion
    this.steerAngle = 0;     // front wheel angle
    this.wheelSpin = 0;      // accumulated rolling angle
    this.lateral = 0;
    this._settled = false;
  }

  /** Base heading down the route, accounting for which way this vehicle faces. */
  roadHeading(s) {
    return this.route.headingAt(s) + (this.direction > 0 ? 0 : Math.PI);
  }

  /** Places the vehicle without inventing any motion for the jump. */
  reset(s, lateral) {
    this.lateral = lateral;
    this._settled = true;
    this.slip = 0;
    this.steerAngle = 0;
    this.route.positionAt(s, lateral, this.position);
    this.heading = this.roadHeading(s);
    this.pitch = -Math.atan(this.route.gradeAt(s) * this.direction);
  }

  update(dt, s, lateral, speed) {
    const route = this.route;
    route.positionAt(s, lateral, this.position);

    // Rate the body is crossing the road, expressed in its own frame: positive
    // is toward its LEFT whichever way it is pointing. Left, because the slip it
    // becomes is added straight onto a yaw, and a positive yaw about +Y turns
    // left; the extra negation converts the route's right-handed lateral axis.
    const drift = this._settled && dt > 1e-6
      ? -((lateral - this.lateral) / dt) * this.direction
      : 0;
    this.lateral = lateral;
    this._settled = true;

    // Slip angle from that crossing rate. Below a walking pace the angle would
    // blow up for a tiny sideways nudge, so the reference speed is floored.
    const targetSlip = clamp(Math.atan2(drift, Math.max(4, Math.abs(speed))), 0.45);
    const k = 1 - Math.exp(-this.response * dt);
    this.slip += (targetSlip - this.slip) * k;
    this.heading = this.roadHeading(s) + this.slip;

    // Front wheels: the Ackermann angle the corner needs, plus the extra the
    // lane change is asking for.
    const roadSteer = Math.atan(this.wheelbase * route.signedCurvatureAt(s) * this.direction);
    const targetSteer = clamp(roadSteer + this.slip * 1.8, this.maxSteer);
    this.steerAngle += (targetSteer - this.steerAngle) * k;

    this.pitch = -Math.atan(route.gradeAt(s) * this.direction);
    this.wheelSpin += (speed * dt) / this.wheelRadius;
  }
}
