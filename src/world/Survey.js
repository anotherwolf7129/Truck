import { Vector3 } from 'three';

/**
 * A route, written the way a survey describes one: run so far, turn so many
 * degrees at such a radius, climb at such a grade.
 *
 * The centreline used to be a list of forty-eight control points read off a
 * sketch. That is workable for a road that mostly goes one way, and it is how
 * that route came to have exactly three corners in seven and a half miles --
 * everything between them was a curve of over a kilometre's radius, which from
 * the cab is a straight line. You cannot see a radius in a list of coordinates,
 * so nobody could see that they were all enormous.
 *
 * Stated as turns, the corner is the unit of design. A turn onto another road is
 * `right(88, 66)` and it is unambiguous that it is an eighty-eight degree turn
 * at sixty-six metres, which is a corner an 87 ft combination gets round with
 * the trailer's rear axles steering, every approach to the intersection stopped,
 * and both carriageways of the road it is turning into.
 *
 * The points come out at a fixed spacing so the spline that gets fitted through
 * them reproduces the arcs rather than rounding them off.
 */
export class Survey {
  /**
   * @param spacing metres between emitted centreline points
   */
  constructor({ x = 0, z = 0, y = 0, heading = 0, spacing = 8 } = {}) {
    this.spacing = spacing;
    this.x = x;
    this.z = z;
    this.y = y;
    this.heading = heading;
    this.length = 0;

    this.points = [new Vector3(x, y, z)];
    this.marks = new Map();
  }

  /** Records the arc length here under a name, for features to be placed at. */
  mark(name) {
    this.marks.set(name, this.length);
    return this;
  }

  /** The arc length of a named mark. Throws rather than silently returning 0. */
  at(name) {
    if (!this.marks.has(name)) throw new Error(`no survey mark named "${name}"`);
    return this.marks.get(name);
  }

  /** Emits one point at the current position. */
  emit() {
    this.points.push(new Vector3(this.x, this.y, this.z));
  }

  /**
   * Straight run.
   * @param distance metres
   * @param grade    rise over run, so -0.09 is a 9% descent
   */
  run(distance, grade = 0) {
    const steps = Math.max(1, Math.round(distance / this.spacing));
    const step = distance / steps;
    const dx = Math.sin(this.heading);
    const dz = Math.cos(this.heading);
    for (let i = 0; i < steps; i++) {
      this.x += dx * step;
      this.z += dz * step;
      this.y += grade * step;
      this.length += step;
      this.emit();
    }
    return this;
  }

  /**
   * Constant-radius turn.
   *
   * @param degrees  how far round; positive turns left, negative right
   * @param radius   metres, measured on the centreline
   * @param grade    rise over run through the turn
   */
  turn(degrees, radius, grade = 0) {
    const sweep = (degrees * Math.PI) / 180;
    const arc = Math.abs(sweep) * radius;
    const steps = Math.max(2, Math.round(arc / this.spacing));

    // Centre of the turn, to the driver's left or right depending on which way
    // it goes. With +Y up and the rig facing +Z the driver's right is
    // `forward x up`, which is (-cos h, 0, sin h) -- the same convention the
    // route's lateral axis and the vehicle bodies use.
    const side = sweep > 0 ? -1 : 1;              // +1 = centre is to the right
    const cx = this.x + side * -Math.cos(this.heading) * radius;
    const cz = this.z + side * Math.sin(this.heading) * radius;

    const startX = this.x - cx;
    const startZ = this.z - cz;
    const startY = this.y;

    for (let i = 1; i <= steps; i++) {
      const phi = (sweep * i) / steps;
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      // Rotation about +Y by phi.
      this.x = cx + startX * cos + startZ * sin;
      this.z = cz + -startX * sin + startZ * cos;
      this.y = startY + grade * (arc * i) / steps;
      this.emit();
    }

    this.heading += sweep;
    this.length += arc;
    return this;
  }

  /** Left and right, so the survey reads as directions rather than as signs. */
  left(degrees, radius, grade = 0) {
    return this.turn(Math.abs(degrees), radius, grade);
  }

  right(degrees, radius, grade = 0) {
    return this.turn(-Math.abs(degrees), radius, grade);
  }

  /**
   * An S-bend: one way and then back, which is what a road does to get round
   * something without changing the direction it is heading in.
   */
  weave(degrees, radius, grade = 0) {
    this.turn(degrees, radius, grade);
    this.turn(-degrees, radius, grade);
    return this;
  }
}
