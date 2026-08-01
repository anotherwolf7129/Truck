import { RoadPose } from './RoadPose.js';

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

/**
 * The convoy as ambient traffic sees it: a string of solid objects on the road.
 *
 * Traffic that only knows about other traffic will drive straight through the
 * load and the escorts, which is exactly what the rear police unit is there to
 * prevent. Each entry is an occupied span of route with a lane position, so a
 * car can both queue behind it and refuse to pass through it.
 */
export function convoyObstacles(world) {
  const out = [];
  const convoy = world.convoy;
  if (convoy) {
    const length = convoy.length ?? 27;
    out.push({
      front: convoy.s,
      rear: convoy.s - length,
      speed: Math.max(0, convoy.speed ?? 0),
      lateral: convoy.lateral ?? 0,
      halfWidth: convoy.halfWidth ?? 1.9,
    });
  }
  for (const e of world.escorts ?? []) {
    const half = (e.length ?? 4.9) * 0.5;
    out.push({
      front: e.s + half,
      rear: e.s - half,
      speed: Math.max(0, e.speed ?? 0),
      lateral: e.lateral ?? 0,
      halfWidth: (e.width ?? 1.95) * 0.5,
    });
  }
  return out;
}

// Fallback for how far behind the load the escort formation reaches, used when
// the caller has not said where its units actually are.
const CONVOY_TAIL = 450;

/**
 * The point behind the load where the escort operation ends.
 *
 * Oncoming traffic stays off the road until everything in the convoy is past,
 * not just the load: a unit that has released a junction runs the best part of a
 * kilometre back up the closed lane to take the next one, and that lane has to
 * still be closed when it does. The tail therefore comes from where the units
 * actually are rather than from a fixed distance.
 */
export function convoyRear(obstacles, fallback) {
  let rear = Infinity;
  for (const o of obstacles) rear = Math.min(rear, o.rear);
  return Number.isFinite(rear) ? rear - 60 : fallback;
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

    this.state = 'driving';        // driving | queued | yielding | stopped | pulled-over
    this.brakeLight = false;
    this.hazards = false;
    this.stoppedTimer = 0;

    this.length = kind === 'truck' ? 16 : 4.6;
    this.width = kind === 'truck' ? 2.5 : 1.85;

    this.pose = new RoadPose(route, {
      direction,
      wheelRadius: kind === 'truck' ? 0.46 : 0.34,
      wheelbase: kind === 'truck' ? 4.2 : 2.85,
    });
    this.position = this.pose.position;
    this.heading = 0;
    this.pose.reset(this.s, this.currentOffset);
    this.heading = this.pose.heading;
  }

  updateTransform(dt = 0) {
    this.pose.update(dt, this.s, this.currentOffset, this.speed);
    this.heading = this.pose.heading;
  }

  /**
   * How far off the centreline this vehicle sits when it gets out of the way.
   *
   * Right to the edge of the shoulder, measured from its own outside edge -- a
   * 2.5 m truck parked at a car's offset still has a foot of itself in the lane
   * the escorts need to get by in.
   */
  shoulderOffset(side) {
    return side * (this.route.roadHalfWidth - this.width * 0.5 - 0.2);
  }

  /** True if this vehicle and an occupied span of road share any lane space. */
  overlapsLaterally(obstacle) {
    return Math.abs(obstacle.lateral - this.currentOffset)
      < obstacle.halfWidth + this.width * 0.5 + 0.35;
  }

  /**
   * @param leader  the vehicle ahead in this lane, or null
   * @param world   { convoy, escorts, blockades, route }
   */
  update(dt, leader, world) {
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

    // --- Don't drive through the convoy -------------------------------------
    // The load and its escorts are solid. Anything in this lane ahead of the
    // vehicle is followed exactly like another car, which is what puts traffic
    // coming up from behind into a queue at the back of the escort formation
    // instead of straight past the load.
    const obstacles = world.obstacles ?? convoyObstacles(world);
    let blockAt = null;
    let headOn = Infinity;
    for (const o of obstacles) {
      // The edge facing this vehicle, and how far ahead of it that edge is.
      const near = this.direction > 0 ? o.rear : o.front;
      const ahead = (near - this.s) * this.direction;
      if (ahead <= 0) continue;
      const g = ahead - this.length * 0.5;

      // Something coming the other way up this vehicle's own lane -- a police
      // unit running ahead to the next junction, most often. This is measured
      // against the lane rather than against where the car currently is, so
      // that pulling off does not make the reason to pull off disappear.
      if (this.direction < 0
        && Math.abs(o.lateral - this.laneOffset) < o.halfWidth + this.width * 0.5 + 0.35) {
        headOn = Math.min(headOn, g);
      }

      if (!this.overlapsLaterally(o)) continue;
      if (g < gap) {
        gap = g;
        // Same-direction traffic closes on the convoy's speed; oncoming closes
        // at the sum of both, which is why it has to stop rather than squeeze by.
        closing = this.speed - (this.direction > 0 ? o.speed : -o.speed);
      }
      if (blockAt === null || (near - blockAt) * this.direction < 0) blockAt = near;
    }

    // --- Get out of the way of the load ------------------------------------
    // The load is wider than a lane. Oncoming traffic cannot pass it on the
    // pavement, so it takes the shoulder and stops until the convoy is by.
    const convoy = world.convoy;
    if (convoy) {
      const rel = (convoy.s - this.s) * this.direction;   // + = load is ahead of me
      const convoyLength = convoy.length ?? 27;

      const rearOfConvoy = world.convoyRear ?? (convoy.s - CONVOY_TAIL);

      if (this.direction < 0 && this.s > rearOfConvoy && rel < 320) {
        // Oncoming and the convoy is coming: pull onto the shoulder and wait.
        //
        // The wait runs until the whole formation is past, not just the load.
        // The escorts leapfrog by running up this lane -- it is closed for as
        // long as the move is in the area, which is the point of the police
        // units being there at all.
        this.targetOffset = this.shoulderOffset(-1);
        this.hazards = true;
        if (rel < 190) { desired = 0; this.state = 'pulled-over'; }
      } else if (this.direction > 0 && rel < 0 && rel > -(convoyLength + 40)) {
        // The load has caught this vehicle from behind, which should not happen
        // -- but if it does, ease right and let it by.
        this.targetOffset = this.shoulderOffset(1);
        this.hazards = true;
      } else if (this.direction > 0 && rel > 0 && rel < 420) {
        // Coming up behind the convoy. Nothing gets past the rear escort, so
        // traffic settles in behind it and runs at the load's speed. The rest
        // of the spacing falls out of following the escort as a leader.
        desired = Math.min(desired, Math.max(0, convoy.speed ?? 0));
        this.targetOffset = this.laneOffset;
        this.hazards = false;
        if (this.state !== 'yielding') this.state = 'queued';
      } else {
        this.targetOffset = this.laneOffset;
        this.hazards = false;
        if (this.state !== 'driving') this.state = 'driving';
      }
    }

    // A unit coming up this lane the wrong way, lights going, is not something
    // to stop dead in front of and wait: get right over and let it through.
    if (headOn < 200) {
      this.targetOffset = this.shoulderOffset(-1);
      this.hazards = true;
      if (headOn < 90) {
        desired = 0;
        if (this.state === 'driving' || this.state === 'queued') this.state = 'pulled-over';
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

    // Car following is a soft constraint and a heavy enough closing rate can
    // still overrun it. Nothing is allowed to end a frame inside the convoy.
    if (blockAt !== null) {
      const limit = blockAt - (this.length * 0.5 + 1.2) * this.direction;
      if ((this.s - limit) * this.direction > 0) {
        this.s = limit;
        this.speed = Math.min(this.speed, Math.max(0, convoyFollowSpeed(obstacles, this)));
        this.brakeLight = true;
      }
    }

    this.updateTransform(dt);
  }

  /** True once this vehicle has run off the end of the route. */
  isOffRoute() {
    return this.s < -60 || this.s > this.route.length + 60;
  }
}

/** Speed of whatever this vehicle has run up against, so it matches it rather than stopping dead. */
function convoyFollowSpeed(obstacles, vehicle) {
  let best = 0;
  let bestGap = Infinity;
  for (const o of obstacles) {
    if (!vehicle.overlapsLaterally(o)) continue;
    const near = vehicle.direction > 0 ? o.rear : o.front;
    const ahead = (near - vehicle.s) * vehicle.direction;
    if (ahead >= -1 && ahead < bestGap) { bestGap = ahead; best = o.speed; }
  }
  return vehicle.direction > 0 ? best : 0;
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

    // The convoy is the same set of obstacles for everyone this frame.
    const obstacles = world.obstacles ?? convoyObstacles(world);
    const frame = {
      ...world,
      obstacles,
      convoyRear: world.convoyRear ?? convoyRear(obstacles, convoyS - CONVOY_TAIL),
    };

    // Resolve leaders per direction so car-following works within each lane.
    const lanes = { 1: [], '-1': [] };
    for (const v of this.vehicles) lanes[v.direction].push(v);
    for (const dir of [1, -1]) {
      const list = lanes[dir];
      list.sort((a, b) => (a.s - b.s) * dir);
      for (let i = 0; i < list.length; i++) {
        list[i].update(dt, list[i + 1] ?? null, frame);
      }
    }
  }
}
