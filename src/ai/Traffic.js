import { RoadPose } from './RoadPose.js';
import { Phase } from '../world/Signal.js';

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
      parked: e.state === 'blocking',
    });
  }
  return out;
}

/**
 * The band of road the move occupies, in metres either side of the centreline.
 *
 * On a two-lane road this is academic -- the load is wider than its lane and the
 * escorts leapfrog up the other one, so the answer is always "all of it". On a
 * five-lane arterial it is the whole point: the load has the inside lane, the
 * units run up the inside lane on the other side, the turn lane between them is
 * nobody's, and the two kerb lanes are left alone. Traffic that knows where the
 * band is can simply move over one and keep going instead of stopping on the
 * shoulder.
 *
 * Units parked on a side road are excluded: a car sitting across the mouth of
 * Kesler Road is not a reason for anybody to leave the highway.
 */
export function convoyCorridor(world, route = world.route) {
  const convoy = world.convoy;
  if (!convoy) return null;
  let min = (convoy.lateral ?? 0) - (convoy.halfWidth ?? 1.9);
  let max = (convoy.lateral ?? 0) + (convoy.halfWidth ?? 1.9);

  // The lane the units leapfrog up is shut for as long as the move is in the
  // area, whether or not one happens to be in it this second. On a two-lane road
  // that is the only oncoming lane there is, which is why oncoming traffic ends
  // up on the shoulder there and merely one lane over in town.
  if (route) {
    const pass = route.laneOffsetAt(convoy.s, -1, 0);
    min = Math.min(min, pass - 1.15);
    max = Math.max(max, pass + 1.15);
  }

  for (const e of world.escorts ?? []) {
    if (Math.abs(e.s - convoy.s) > 600) continue;
    // A unit that is off the travelled way is not closing a lane -- it is parked
    // across the mouth of a side road, or picking its way back onto the highway
    // from one. Only what is actually on the pavement counts.
    if (e.state === 'blocking') continue;
    if (route && Math.abs(e.lateral) > route.edgeOffsetAt(e.s)) continue;
    min = Math.min(min, e.lateral - e.width * 0.5);
    max = Math.max(max, e.lateral + e.width * 0.5);
  }
  return { min: min - 0.5, max: max + 0.5 };
}

// Fallback for how far behind the load the escort formation reaches, used when
// the caller has not said where its units actually are.
const CONVOY_TAIL = 450;

// How far short of a junction traffic stops while a unit is crossing to it.
// Far enough back that the stopped car is not sitting in the space the unit is
// trying to move through.
const MAINLINE_STOP_BACK = 35;

/** Half the width of the intersection box, along the highway. */
export function intersectionHalfLength(junction) {
  return junction.signal ? 8.5 : 5.0;
}

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
 * route properly, keep to a lane, stop at the lights, obey the escorts, and get
 * out of the way of a load that is wider than the lane it is travelling in.
 */
export class TrafficVehicle {
  constructor({ route, s, direction = 1, kind = 'car' }) {
    this.id = nextId++;
    this.route = route;
    this.kind = kind;
    this.direction = direction;   // +1 travels with the convoy, -1 is oncoming

    this.s = s;
    this.speed = 0;
    // Drivers are held to the posted limit rather than to one speed for the
    // whole route, so the same car runs at 45 on the county highway and 35
    // through town -- with its own opinion of the sign applied on top.
    this.speedFactor = kind === 'truck'
      ? 0.82 + Math.random() * 0.14
      : 0.92 + Math.random() * 0.24;

    // Lane index, counting outward from the centreline. Most drivers sit in the
    // kerb lane; a third of them use the inside lane, which is what puts anyone
    // in the load's way on a road wide enough to have one.
    this.insideLanePreference = Math.random() < 0.34;
    this.lane = this.preferredLane(s);
    this.laneOffset = route.laneOffsetAt(s, direction, this.lane);
    this.targetOffset = this.laneOffset;
    this.currentOffset = this.laneOffset;

    this.state = 'driving';        // driving | queued | yielding | stopped | pulled-over | light
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

  /** Cruising speed here, from the posted limit and this driver's opinion of it. */
  cruiseSpeed(s = this.s) {
    const limit = this.route.speedLimitAt(s) / 2.23694;
    return Math.max(4, limit * this.speedFactor);
  }

  /** The lane this driver would choose here if nothing were in the way. */
  preferredLane(s = this.s) {
    const count = this.route.laneCountAt(s);
    if (count <= 1) return 0;
    // Trucks keep to the kerb lane whatever their driver would prefer.
    if (this.kind === 'truck') return count - 1;
    return this.insideLanePreference ? 0 : count - 1;
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
    return side * (this.route.halfWidthAt(this.s) - this.width * 0.5 - 0.2);
  }

  /** True if this vehicle and an occupied span of road share any lane space. */
  overlapsLaterally(obstacle) {
    return Math.abs(obstacle.lateral - this.currentOffset)
      < obstacle.halfWidth + this.width * 0.5 + 0.35;
  }

  /** True if a lane centre would leave this vehicle clear of the convoy's band. */
  laneClearsCorridor(offset, corridor) {
    if (!corridor) return true;
    const half = this.width * 0.5;
    return offset - half > corridor.max || offset + half < corridor.min;
  }

  /**
   * Picks a lane, and reports whether the move it wants is safe to make.
   *
   * Three things decide it: the lane the driver would rather be in, whether the
   * lane they are in still exists a few seconds up the road, and whether the
   * convoy is using it. The last one is why this matters -- on the arterial an
   * oncoming car that would have had to stop on the shoulder can simply move to
   * the kerb lane and carry on.
   */
  chooseLane(world) {
    const route = this.route;
    const count = route.laneCountAt(this.s);
    // A lane that ends up the road is not a lane you can stay in. The taper is
    // signed well before it, which is what the look-ahead stands in for.
    const ahead = this.s + this.direction * Math.max(70, this.speed * 5);
    const surviving = Math.min(count, route.laneCountAt(ahead));

    let lane = Math.min(this.lane, surviving - 1);
    let want = Math.min(this.preferredLane(this.s), surviving - 1);

    const corridor = world.corridor;
    if (corridor && count > 1) {
      const relevant = world.convoy
        && Math.abs(world.convoy.s - this.s) < (this.direction < 0 ? 420 : 340);
      if (relevant) {
        // Take the outermost lane that keeps clear of the move. Only if none of
        // them do does this become a shoulder job.
        for (let i = surviving - 1; i >= 0; i--) {
          if (this.laneClearsCorridor(route.laneOffsetAt(this.s, this.direction, i), corridor)) {
            want = i;
            break;
          }
        }
      }
    }

    if (want !== lane) {
      // One lane at a time, and only when the space beside is actually empty.
      const step = Math.sign(want - lane);
      if (this.laneChangeClear(lane + step, world)) lane += step;
    }

    this.lane = Math.max(0, lane);
    return this.lane;
  }

  /** True if the lane beside this one has room to move into. */
  laneChangeClear(lane, world) {
    const offset = this.route.laneOffsetAt(this.s, this.direction, lane);
    for (const other of world.neighbours ?? []) {
      if (other === this || other.direction !== this.direction) continue;
      if (Math.abs(other.currentOffset - offset) > (other.width + this.width) * 0.5 + 0.5) continue;
      const along = (other.s - this.s) * this.direction;
      // Room in front to pull into, and enough behind not to cut anybody up.
      if (along < 14 && along > -10) return false;
    }
    for (const o of world.obstacles ?? []) {
      if (Math.abs(o.lateral - offset) > o.halfWidth + this.width * 0.5 + 0.5) continue;
      const front = (o.front - this.s) * this.direction;
      const rear = (o.rear - this.s) * this.direction;
      if (Math.min(front, rear) < 30 && Math.max(front, rear) > -20) return false;
    }
    return true;
  }

  /**
   * @param leader  the vehicle ahead in this lane, or null
   * @param world   { convoy, escorts, blockades, signals, route }
   */
  update(dt, leader, world) {
    const route = this.route;
    let desired = this.cruiseSpeed();
    let gap = Infinity;
    let closing = 0;

    // Anything that has to be stopped short of is folded in as a stationary
    // obstacle rather than by zeroing the desired speed, so the car brakes for
    // it over a sensible distance instead of arriving at it and switching off.
    const stopFor = (distance) => {
      if (distance < gap) { gap = distance; closing = Math.max(0, this.speed); }
    };

    if (leader) {
      gap = Math.abs(leader.s - this.s) * 1 - (leader.length + this.length) * 0.5;
      closing = this.speed - leader.speed;
    }

    // --- Lane choice --------------------------------------------------------
    const lane = this.chooseLane(world);
    this.laneOffset = route.laneOffsetAt(this.s, this.direction, lane);
    this.targetOffset = this.laneOffset;

    // --- Traffic signals ----------------------------------------------------
    // A light the escorts have taken reads green, which is the whole reason the
    // units take it: the queue in front of the load clears before it gets there.
    const signal = world.signals?.next?.(this.s, this.direction) ?? null;
    if (signal) {
      const stopLine = (signal.s - this.s) * this.direction
        - intersectionHalfLength(signal.junction) - 1.5 - this.length * 0.5;
      const phase = signal.mainline;
      if (stopLine > -2) {
        // On yellow, stop if there is room to; if there is not, the car is
        // already committed and going through is the safer of the two.
        const canStop = stopLine > (this.speed * this.speed) / (2 * 2.6) + 1.5;
        if (phase === Phase.RED || (phase === Phase.YELLOW && canStop)) {
          stopFor(stopLine);
          if (this.speed < 1.5) this.state = 'light';
        }
      }
    }

    // --- Obey the escorts ---------------------------------------------------
    // A police unit crossing the carriageway to reach a junction stops
    // everything on the approach until it is parked.
    //
    // The stop line is set well back rather than at the junction itself: the
    // unit is manoeuvring across the road right there, and a car halted on top
    // of it reads to `laneClear` as a reason never to finish crossing -- which
    // is a standoff neither of them can break.
    let yielding = false;
    for (const b of world.blockades) {
      if (!b.active || !b.holdsMainline) continue;
      const ahead = (b.s - this.s) * this.direction;
      if (ahead > 0 && ahead < 220) {
        stopFor(ahead - MAINLINE_STOP_BACK);
        yielding = true;
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
      if (this.direction < 0 && !o.parked
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
    // The load is wider than a lane. Where there is only one lane each way,
    // oncoming traffic cannot pass it on the pavement at all, so it takes the
    // shoulder and stops until the convoy is by. Where there are two, moving
    // over one is enough and the traffic keeps rolling -- which is the whole
    // difference between escorting a load down a county road and through town.
    const convoy = world.convoy;
    if (convoy) {
      const rel = (convoy.s - this.s) * this.direction;   // + = load is ahead of me
      const convoyLength = convoy.length ?? 27;
      const rearOfConvoy = world.convoyRear ?? (convoy.s - CONVOY_TAIL);
      const laneWorks = this.laneClearsCorridor(this.laneOffset, world.corridor);

      if (this.direction < 0 && this.s > rearOfConvoy && rel < 320) {
        if (laneWorks) {
          // Room to keep going: hold the lane the lane chooser found, ease off,
          // and let the move come past.
          desired = Math.min(desired, this.cruiseSpeed() * 0.6);
          this.hazards = false;
          this.state = 'driving';
        } else {
          // Oncoming and the convoy is coming: pull onto the shoulder and wait.
          //
          // The wait runs until the whole formation is past, not just the load.
          // The escorts leapfrog by running up this lane -- it is closed for as
          // long as the move is in the area, which is the point of the police
          // units being there at all.
          this.targetOffset = this.shoulderOffset(-1);
          this.hazards = true;
          if (rel < 190) { desired = 0; this.state = 'pulled-over'; }
        }
      } else if (this.direction > 0 && rel < 0 && rel > -(convoyLength + 40)) {
        // The load has caught this vehicle from behind, which should not happen
        // -- but if it does, ease right and let it by.
        this.targetOffset = this.shoulderOffset(1);
        this.hazards = true;
      } else if (this.direction > 0 && rel > 0 && rel < 420) {
        // Coming up behind the convoy. Nothing gets past the rear escorts -- on
        // the arterial they run one lane each, so the queue forms in both.
        //
        // Traffic only matches the load's speed once it is actually up with the
        // formation. Doing it the moment the load is in sight leaves a quarter
        // mile of empty road behind an escorted move, when what should be back
        // there is the queue everybody stuck behind it is sitting in.
        if (rel < 220) desired = Math.min(desired, Math.max(0, convoy.speed ?? 0));
        this.hazards = false;
        this.state = 'queued';
      } else {
        this.hazards = false;
        this.state = 'driving';
      }
    }

    // Held for a unit crossing the road. Applied here, after the convoy states
    // above have had their say, and recomputed every frame rather than latched
    // into `state` -- so a car starts moving again the moment the unit is parked
    // and the highway reopens. Being pulled over for the load itself is the more
    // urgent of the two and already has the vehicle stopped, so it wins.
    if (yielding && this.state !== 'pulled-over') this.state = 'yielding';

    // A unit coming up this lane the wrong way, lights going, is not something
    // to stop dead in front of and wait: get out of its way and let it through.
    // Where there is another lane that is enough; where there is not, that means
    // the shoulder and a stop.
    if (headOn < 200) {
      const outerLane = route.laneCountAt(this.s) - 1;
      const outer = route.laneOffsetAt(this.s, this.direction, outerLane);
      const roomToMove = outerLane > lane && Math.abs(outer - this.laneOffset) > 1;
      if (roomToMove) {
        this.lane = outerLane;
        this.laneOffset = outer;
        this.targetOffset = outer;
      } else {
        this.targetOffset = this.shoulderOffset(-1);
        this.hazards = true;
        if (headOn < 90) {
          desired = 0;
          if (this.state === 'driving' || this.state === 'queued') this.state = 'pulled-over';
        }
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
    v.speed = v.cruiseSpeed() * 0.9;
    this.vehicles.push(v);
    return v;
  }

  /**
   * How much traffic this stretch of road carries.
   *
   * A suburban arterial is busier than a county highway and much busier than a
   * fire road over a ridge, and the difference is most of what makes the drive
   * into town feel like arriving somewhere.
   */
  spawnInterval(s) {
    const kind = this.route.kindAt(s);
    const base = kind === 'suburban' ? 0.85 : kind === 'mountain' ? 2.6 : 1.4;
    return base / Math.max(0.2, this.density);
  }

  update(dt, world) {
    const convoyS = world.convoy ? world.convoy.s : 0;

    // Recycle anything that has left the window.
    this.vehicles = this.vehicles.filter((v) => {
      if (v.isOffRoute()) return false;
      return Math.abs(v.s - convoyS) < this.despawnWindow;
    });

    const cap = this.route.kindAt(convoyS) === 'suburban'
      ? Math.round(this.maxVehicles * 1.5)
      : this.maxVehicles;

    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0 && this.vehicles.length < cap) {
      this._spawnTimer = this.spawnInterval(convoyS);
      this.spawn(convoyS, Math.random() < 0.55 ? -1 : 1);
    }

    // The convoy is the same set of obstacles for everyone this frame.
    const obstacles = world.obstacles ?? convoyObstacles(world);
    const frame = {
      ...world,
      route: world.route ?? this.route,
      // The lights are on the route, so a caller that did not pass them still
      // gets traffic that stops at them.
      signals: world.signals ?? this.route.signals ?? null,
      obstacles,
      neighbours: this.vehicles,
      corridor: world.corridor ?? convoyCorridor(world, this.route),
      convoyRear: world.convoyRear ?? convoyRear(obstacles, convoyS - CONVOY_TAIL),
    };

    // Resolve leaders per direction. With more than one lane the vehicle ahead
    // is not necessarily the vehicle to follow -- a car in the kerb lane is no
    // reason for anybody in the inside lane to brake -- so the search walks
    // forward until it finds one actually in the way.
    const lanes = { 1: [], '-1': [] };
    for (const v of this.vehicles) lanes[v.direction].push(v);
    for (const dir of [1, -1]) {
      const list = lanes[dir];
      list.sort((a, b) => (a.s - b.s) * dir);
      for (let i = 0; i < list.length; i++) {
        list[i].update(dt, findLeader(list, i), frame);
      }
    }
  }
}

/** The nearest vehicle ahead that shares lane space with this one. */
function findLeader(list, i) {
  const self = list[i];
  for (let j = i + 1; j < list.length && j <= i + 6; j++) {
    const other = list[j];
    if (Math.abs(other.currentOffset - self.currentOffset)
      < (other.width + self.width) * 0.5 + 0.3) return other;
  }
  return null;
}
