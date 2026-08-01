import { Vector3 } from 'three';

const _p = new Vector3();

/**
 * Intelligent Driver Model acceleration.
 *
 * Standard car-following: drivers accelerate toward a desired speed but back
 * off as the gap to the vehicle ahead closes, with the safe following distance
 * growing with speed and closing rate.
 */
export function idm(v, desiredV, gap, closingRate, {
  maxAccel = 1.6, comfortBrake = 2.2, minGap = 6, headway = 1.6, delta = 4,
} = {}) {
  const free = 1 - Math.pow(Math.max(0, v) / Math.max(0.1, desiredV), delta);
  if (!Number.isFinite(gap) || gap > 400) return maxAccel * free;

  const sStar = minGap + Math.max(
    0,
    v * headway + (v * closingRate) / (2 * Math.sqrt(maxAccel * comfortBrake))
  );
  const interaction = Math.pow(sStar / Math.max(0.8, gap), 2);
  return maxAccel * (free - interaction);
}

let nextId = 1;

/**
 * One piece of ambient traffic.
 *
 * These are kinematic rather than fully simulated -- the player's rig is the
 * only vehicle worth spending a constraint solver on -- but they follow the
 * route properly, obey the escorts, and get out of the way of a load that is
 * wider than the lane it is travelling in.
 */
export class TrafficVehicle {
  constructor({ route, s, direction = 1, kind = 'car' }) {
    this.id = nextId++;
    this.route = route;
    this.kind = kind;
    this.direction = direction;   // +1 travels with the convoy, -1 is oncoming

    this.s = s;
    this.speed = 0;
    this.desiredSpeed = (kind === 'truck' ? 24 : 29) * (0.85 + Math.random() * 0.3);

    // Lane centre offset. Right-hand traffic: with-convoy traffic sits right of
    // the centreline, oncoming sits left of it (from the convoy's point of view).
    this.laneOffset = direction > 0 ? route.laneWidth * 0.5 : -route.laneWidth * 0.5;
    this.targetOffset = this.laneOffset;
    this.currentOffset = this.laneOffset;

    this.position = new Vector3();
    this.heading = 0;
    this.state = 'driving';        // driving | yielding | stopped | pulled-over
    this.brakeLight = false;
    this.hazards = false;
    this.stoppedTimer = 0;

    this.length = kind === 'truck' ? 16 : 4.6;
    this.width = kind === 'truck' ? 2.5 : 1.85;

    this.updateTransform();
  }

  updateTransform() {
    this.route.positionAt(this.s, this.currentOffset, this.position);
    const h = this.route.headingAt(this.s);
    this.heading = this.direction > 0 ? h : h + Math.PI;
  }

  /**
   * @param leader  the vehicle ahead in this lane, or null
   * @param world   { convoy, blockades, route }
   */
  update(dt, leader, world) {
    const route = this.route;
    let desired = this.desiredSpeed;
    let gap = Infinity;
    let closing = 0;

    if (leader) {
      gap = Math.abs(leader.s - this.s) * 1 - (leader.length + this.length) * 0.5;
      closing = this.speed - leader.speed;
    }

    // --- Obey the escorts ---------------------------------------------------
    // A police unit holding a junction stops everything on the approach.
    for (const b of world.blockades) {
      if (!b.active) continue;
      const ahead = (b.s - this.s) * this.direction;
      if (ahead > 0 && ahead < 220 && b.holdsMainline) {
        gap = Math.min(gap, ahead - 8);
        desired = 0;
        this.state = 'yielding';
      }
    }

    // --- Get out of the way of the load ------------------------------------
    // The load is wider than a lane. Oncoming traffic cannot pass it on the
    // pavement, so it takes the shoulder and stops until the convoy is by.
    const convoy = world.convoy;
    if (convoy) {
      const rel = (convoy.s - this.s) * this.direction;
      const near = Math.abs(convoy.s - this.s);

      if (this.direction < 0 && rel > -convoy.length && rel < 320) {
        // Oncoming and the convoy is approaching: pull onto the shoulder.
        this.targetOffset = -(route.laneWidth * 0.5 + route.shoulderWidth * 0.85);
        this.hazards = true;
        if (near < 190) { desired = 0; this.state = 'pulled-over'; }
      } else if (this.direction > 0 && convoy.s > this.s && convoy.s - this.s < 40) {
        // Being overtaken by the convoy from behind should not happen, but if
        // the convoy catches this vehicle, ease right and let it by.
        this.targetOffset = route.laneWidth * 0.5 + route.shoulderWidth * 0.5;
        this.hazards = true;
      } else if (this.direction > 0 && this.s > convoy.s && this.s - convoy.s < 500) {
        // Ahead of the convoy in the same direction: the rear escort will not
        // let anyone pass, so traffic behind simply queues at convoy speed.
        desired = Math.min(desired, Math.max(0, convoy.speed));
      } else {
        this.targetOffset = this.laneOffset;
        this.hazards = false;
        if (this.state !== 'driving') this.state = 'driving';
      }
    }

    // --- Longitudinal -------------------------------------------------------
    const accel = idm(this.speed, desired, gap, closing);
    const prev = this.speed;
    this.speed = Math.max(0, this.speed + accel * dt);
    this.brakeLight = this.speed < prev - 0.05;

    if (this.speed < 0.2) {
      this.stoppedTimer += dt;
      if (desired === 0) this.state = this.state === 'driving' ? 'stopped' : this.state;
    } else {
      this.stoppedTimer = 0;
    }

    // --- Lateral ------------------------------------------------------------
    // Lane changes and shoulder pull-offs are eased rather than snapped.
    const rate = this.state === 'pulled-over' ? 1.4 : 0.9;
    this.currentOffset += (this.targetOffset - this.currentOffset) * Math.min(1, rate * dt);

    this.s += this.speed * this.direction * dt;
    this.updateTransform();
  }

  /** True once this vehicle has run off the end of the route. */
  isOffRoute() {
    return this.s < -60 || this.s > this.route.length + 60;
  }
}

/**
 * Spawns and manages ambient traffic in a window around the convoy.
 *
 * Traffic only exists near the player; vehicles are recycled once they fall far
 * enough behind, which keeps the count bounded without the world feeling empty.
 */
export class TrafficManager {
  constructor(route, { density = 1 } = {}) {
    this.route = route;
    this.vehicles = [];
    this.density = density;
    this.spawnWindow = 900;
    this.despawnWindow = 1100;
    this.maxVehicles = Math.round(26 * density);
    this._spawnTimer = 0;
  }

  spawn(convoyS, direction) {
    const route = this.route;
    // Place new traffic at the far edge of the window, ahead for oncoming and
    // behind for same-direction, so nothing pops into view.
    const offset = this.spawnWindow * (0.75 + Math.random() * 0.25);
    const s = direction < 0 ? convoyS + offset : convoyS - offset;
    if (s < 0 || s > route.length) return null;

    const kind = Math.random() < 0.16 ? 'truck' : 'car';
    const v = new TrafficVehicle({ route, s, direction, kind });
    v.speed = v.desiredSpeed * 0.9;
    this.vehicles.push(v);
    return v;
  }

  update(dt, world) {
    const convoyS = world.convoy ? world.convoy.s : 0;

    // Recycle anything that has left the window.
    this.vehicles = this.vehicles.filter((v) => {
      if (v.isOffRoute()) return false;
      return Math.abs(v.s - convoyS) < this.despawnWindow;
    });

    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0 && this.vehicles.length < this.maxVehicles) {
      this._spawnTimer = 1.4 / Math.max(0.2, this.density);
      this.spawn(convoyS, Math.random() < 0.55 ? -1 : 1);
    }

    // Resolve leaders per direction so car-following works within each lane.
    const lanes = { 1: [], '-1': [] };
    for (const v of this.vehicles) lanes[v.direction].push(v);
    for (const dir of [1, -1]) {
      const list = lanes[dir];
      list.sort((a, b) => (a.s - b.s) * dir);
      for (let i = 0; i < list.length; i++) {
        list[i].update(dt, list[i + 1] ?? null, world);
      }
    }
  }
}
