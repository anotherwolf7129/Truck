import { Vector3 } from 'three';
import { RoadPose } from './RoadPose.js';

const _v = new Vector3();

export const Role = {
  LEAD_POLICE: 'lead_police',
  LEAD_PILOT: 'lead_pilot',
  REAR_PILOT: 'rear_pilot',
  REAR_POLICE: 'rear_police',
};

/**
 * Radio traffic between the convoy.
 *
 * Escort work is almost entirely verbal -- the lead car is the driver's eyes a
 * quarter mile up the road, and everything from a low bridge to an oncoming
 * school bus arrives as a voice call before it arrives as a hazard.
 */
export class Radio {
  constructor(limit = 60) {
    this.messages = [];
    this.limit = limit;
    this.listeners = [];
  }

  say(from, text, { priority = 'normal', key = null, cooldown = 0, time = 0 } = {}) {
    // Keyed messages with a cooldown stop the escorts repeating themselves
    // every frame while a condition holds.
    if (key) {
      const prev = this._last?.[key];
      if (prev !== undefined && time - prev < cooldown) return null;
      (this._last ??= {})[key] = time;
    }
    const msg = { from, text, priority, time };
    this.messages.push(msg);
    if (this.messages.length > this.limit) this.messages.shift();
    for (const l of this.listeners) l(msg);
    return msg;
  }

  recent(count = 6) {
    return this.messages.slice(-count);
  }
}

/**
 * A junction the escorts have to hold, plus the cross traffic waiting at it.
 *
 * Blocking a side road is the visible half of escort work: a unit pulls across
 * the mouth of the road with its lights going, everyone waiting there stays
 * waiting, and the load goes through without ever slowing down.
 */
export class Blockade {
  constructor(junction, route) {
    this.junction = junction;
    this.route = route;
    this.s = junction.s;
    this.side = junction.side;
    this.name = junction.name;

    this.active = false;
    this.holdsMainline = false;
    this.assignedTo = null;
    this.released = false;

    // Cross traffic held at the stop line.
    this.queue = [];
    this.queueSeed = Math.random();
  }

  /** World position of the mouth of the side road. */
  mouth(out = new Vector3()) {
    return this.route.positionAt(this.s, this.side * (this.route.roadHalfWidth + 3), out);
  }

  /** Direction the side road runs, away from the highway. */
  direction(out = new Vector3()) {
    const sample = this.route.at(this.s);
    return out.copy(sample.lateral).multiplyScalar(this.side).normalize();
  }

  /** Populates the waiting cross traffic as the convoy gets close. */
  populate() {
    if (this.queue.length) return;
    const count = 1 + Math.floor(this.queueSeed * 3);
    for (let i = 0; i < count; i++) {
      this.queue.push({
        distance: 9 + i * 6.5 + this.queueSeed * 2,
        kind: this.queueSeed > 0.7 && i === 0 ? 'truck' : 'car',
        position: new Vector3(),
        heading: 0,
        waiting: true,
      });
    }
  }

  update() {
    const mouth = this.mouth(_v);
    const dir = this.direction(new Vector3());
    for (const c of this.queue) {
      c.position.copy(mouth).addScaledVector(dir, c.distance);
      c.position.y = this.route.at(this.s).position.y;
      // Facing back toward the highway, waiting to pull out.
      c.heading = Math.atan2(-dir.x, -dir.z);
      c.waiting = this.active;
    }
  }
}

/**
 * A single escort vehicle.
 *
 * Escorts run on rails along the route rather than on the full vehicle physics:
 * what matters about them is where they are relative to the load and what they
 * are doing about the road ahead, not their suspension.
 */
export class EscortVehicle {
  constructor({ route, role, s = 0 }) {
    this.route = route;
    this.role = role;
    this.isPolice = role === Role.LEAD_POLICE || role === Role.REAR_POLICE;

    this.s = s;
    this.lateral = route.laneWidth * 0.5;
    this.targetLateral = this.lateral;
    this.speed = 0;
    this.maxSpeed = this.isPolice ? 38 : 33;   // m/s

    this.state = 'station';      // station | advance | blocking | rejoin
    this.assignment = null;      // Blockade being worked
    this.lightsOn = false;
    this.lightPhase = Math.random() * Math.PI * 2;

    this.length = 4.9;
    this.width = 1.95;

    this.pose = new RoadPose(route, { wheelRadius: 0.34, wheelbase: 2.85 });
    this.position = this.pose.position;
    this.heading = 0;
    this.blockAngle = 0;         // eased angle across the mouth of a side road
    this.place(s, this.lateral);
  }

  /** Snaps to a point on the route, for a standing start or a teleport. */
  place(s, lateral) {
    this.s = s;
    this.lateral = lateral;
    this.targetLateral = lateral;
    this.blockAngle = 0;
    this.pose.reset(s, lateral);
    this.heading = this.pose.heading;
  }

  updateTransform(dt = 0) {
    this.pose.update(dt, this.s, this.lateral, this.speed);
    // Parked across a side road, the unit sits at an angle to the highway so it
    // physically closes the mouth of the road. Swinging into that angle takes a
    // moment, the same as it would in the car.
    const want = this.state === 'blocking' && this.assignment ? this.assignment.side * 1.15 : 0;
    this.blockAngle += (want - this.blockAngle) * Math.min(1, 2.5 * dt);
    this.heading = this.pose.heading + this.blockAngle;
  }

  /**
   * Drives toward a station-keeping target along the route.
   * @param targetS      arc length to hold
   * @param convoySpeed  speed of the load, m/s
   * @param urgency      1 = normal station keeping, >1 = get there now
   */
  driveTo(dt, targetS, convoySpeed, urgency = 1) {
    const error = targetS - this.s;

    // Match the convoy's speed, then add a correction for the position error.
    // Without the feed-forward term the escorts concertina behind the load.
    const correction = Math.max(-14, Math.min(14, error * 0.45 * urgency));
    let desired = Math.max(0, convoySpeed + correction);
    desired = Math.min(desired, this.maxSpeed * urgency);

    const accel = this.isPolice ? 4.2 : 3.4;
    const brake = 6.0;
    const dv = desired - this.speed;
    const rate = dv > 0 ? accel : brake;
    this.speed += Math.max(-rate * dt, Math.min(rate * dt, dv));
    this.speed = Math.max(0, this.speed);

    this.s += this.speed * dt;
    this.lateral += (this.targetLateral - this.lateral) * Math.min(1, 1.6 * dt);
    this.updateTransform(dt);
  }

  /** Comes to a stop at a fixed point, for blocking a junction. */
  holdAt(dt, targetS, targetLateral) {
    const error = targetS - this.s;
    const desired = Math.max(-4, Math.min(9, error * 1.1));
    const dv = desired - this.speed;
    this.speed += Math.max(-7 * dt, Math.min(5 * dt, dv));
    if (Math.abs(error) < 0.6 && Math.abs(this.speed) < 0.8) this.speed = 0;

    this.s += this.speed * dt;
    this.targetLateral = targetLateral;
    // Getting across the road to the mouth of a side road is a manoeuvre done
    // at walking pace with the lights on, not a 70 mph swerve: the unit brakes
    // to the stop line first and crosses as it arrives.
    const crossRate = 2.2 * Math.max(0, 1 - Math.abs(this.speed) / 12);
    this.lateral += (this.targetLateral - this.lateral) * Math.min(1, crossRate * dt);
    this.updateTransform(dt);
  }

  /** True if this unit shares any lane space with an occupied span of road. */
  overlapsLaterally(lateral, halfWidth) {
    return Math.abs(lateral - this.lateral) < halfWidth + this.width * 0.5 + 0.35;
  }
}

/**
 * Runs the whole escort operation.
 *
 * The interesting behaviour is the leapfrog: with two police units and a string
 * of junctions ahead, a unit holds one intersection until the load is through,
 * then releases and runs up the closed lane past the load to take the next one
 * that nobody is covering. Done properly the load never stops, and to the
 * driver it looks like every side road on the route happens to be closed.
 */
export class ConvoyManager {
  constructor(route, rig, { radio = new Radio() } = {}) {
    this.route = route;
    this.rig = rig;
    this.radio = radio;
    this.time = 0;

    this.blockades = route.junctions.map((j) => new Blockade(j, route));

    // Station-keeping distances, metres relative to the load.
    this.stations = {
      [Role.LEAD_POLICE]: 260,
      [Role.LEAD_PILOT]: 140,
      [Role.REAR_PILOT]: -95,
      [Role.REAR_POLICE]: -170,
    };

    this.vehicles = [
      new EscortVehicle({ route, role: Role.LEAD_POLICE }),
      new EscortVehicle({ route, role: Role.LEAD_PILOT }),
      new EscortVehicle({ route, role: Role.REAR_PILOT }),
      new EscortVehicle({ route, role: Role.REAR_POLICE }),
    ];

    this.convoyS = 0;
    this.convoySpeed = 0;
    this.convoyLength = 27;

    // Where the load actually sits across the road. The escorts have to get
    // around it to leapfrog, and it is wide enough that "use the shoulder" is
    // not automatically an answer -- so both of these are kept current from the
    // rig rather than assumed.
    this.loadLateral = route.laneWidth * 0.5;
    this.loadHalfWidth = rig?.cargo?.size ? rig.cargo.size.x * 0.5 : 1.9;

    // Ambient traffic, if the caller wants a unit to look before it swings
    // across the road. Optional: without it the road beside it is assumed clear.
    this.traffic = null;

    // The height pole on the lead car is set just above the load, so it strikes
    // anything the load would strike.
    this.loadHeight = 0;
    this.poleHeight = 0;

    this._announced = new Set();
  }

  /** Puts every escort at its station for a standing start. */
  reset(s) {
    this.convoyS = s;
    for (const v of this.vehicles) {
      v.speed = 0;
      v.state = 'station';
      v.assignment = null;
      v.lightsOn = v.isPolice;
      v.place(s + this.stations[v.role], this.route.laneWidth * 0.5);
    }
    for (const b of this.blockades) {
      b.active = false;
      b.released = false;
      b.assignedTo = null;
      b.queue.length = 0;
    }
    this._announced.clear();
  }

  get leadPilot() { return this.vehicles.find((v) => v.role === Role.LEAD_PILOT); }
  get police() { return this.vehicles.filter((v) => v.isPolice); }

  /**
   * Chooses which junction each police unit should be working.
   *
   * A unit already sitting on a blockade keeps it until the load is past.
   * Free units take the nearest junction ahead of the load that nobody else has,
   * as long as there is enough road left to get there first.
   */
  assignBlockades() {
    const convoyS = this.convoyS;

    for (const unit of this.police) {
      // Release a blockade once the whole combination is clear of it.
      if (unit.assignment && convoyS - this.convoyLength > unit.assignment.s + 25) {
        const done = unit.assignment;
        done.active = false;
        done.released = true;
        done.assignedTo = null;
        unit.assignment = null;
        unit.state = 'rejoin';
        this.radio.say(this.unitName(unit), `${done.name} is clear, releasing traffic. Coming back up.`,
          { key: `rel${done.s}`, cooldown: 30, time: this.time });
      }
    }

    for (const unit of this.police) {
      if (unit.assignment) continue;

      const candidate = this.blockades.find((b) =>
        !b.released && !b.assignedTo && b.s > convoyS + 60
      );
      if (!candidate) continue;

      // Only take it if the unit can realistically beat the load there. A unit
      // behind the load has to run up the shoulder first, which costs time.
      const distance = candidate.s - unit.s;
      const loadEta = (candidate.s - convoyS) / Math.max(2, this.convoySpeed);
      const unitEta = distance / unit.maxSpeed + (unit.s < convoyS ? 8 : 0);
      if (unitEta > loadEta - 6) continue;

      candidate.assignedTo = unit;
      unit.assignment = candidate;
      unit.state = 'advance';
      this.radio.say(this.unitName(unit), `Running ahead to ${candidate.name}, I'll hold it for you.`,
        { key: `adv${candidate.s}`, cooldown: 30, time: this.time });
    }
  }

  /**
   * The lane position a unit uses to get around the load.
   *
   * A 3.66 m load in a 3.7 m lane leaves nothing usable beside it: the shoulder
   * is only 2.4 m and the load already overhangs into most of it. So the pass
   * goes down the other side of the road -- which is exactly why the escorts
   * close the oncoming lane and why oncoming traffic is sitting on the far
   * shoulder while the load goes through.
   */
  passLateral(unit) {
    const r = this.route;
    const half = unit.width * 0.5;
    const clearance = 0.6;
    const roomRight = r.roadHalfWidth - (this.loadLateral + this.loadHalfWidth);
    if (roomRight >= half * 2 + clearance) {
      return this.loadLateral + this.loadHalfWidth + clearance + half;
    }
    return Math.min(
      -r.laneWidth * 0.5,
      this.loadLateral - this.loadHalfWidth - clearance - half
    );
  }

  /**
   * Whether a unit can swing across the road to the mouth of a side road yet.
   *
   * The unit is stopped at the junction by this point and the junction is held
   * from the moment it arrives, so waiting for a gap costs the convoy nothing --
   * and sweeping across the oncoming lane into whatever is there costs a lot.
   */
  laneClear(unit, targetLateral, crossSeconds = 2.2) {
    if (!this.traffic || this.traffic.length === 0) return true;
    if (Math.abs(targetLateral - unit.lateral) < 0.4) return true;

    const lo = Math.min(unit.lateral, targetLateral) - unit.width * 0.5 - 0.4;
    const hi = Math.max(unit.lateral, targetLateral) + unit.width * 0.5 + 0.4;

    for (const v of this.traffic) {
      const halfWidth = v.width * 0.5;
      if (v.currentOffset + halfWidth < lo || v.currentOffset - halfWidth > hi) continue;

      // Only whoever is actually closing on the unit matters: a slower car it
      // has already gone by is not a reason to wait.
      const along = v.direction > 0 ? v.speed : -v.speed;
      const separation = v.s - unit.s;
      const closing = separation > 0 ? unit.speed - along : along - unit.speed;
      const margin = (v.length + unit.length) * 0.5 + Math.max(0, closing) * crossSeconds + 1.5;
      if (Math.abs(separation) < margin) return false;
    }
    return true;
  }

  /**
   * A unit parked off the road comes back onto it when the shoulder beside it
   * is clear.
   *
   * Leaving a junction means crossing the shoulder that oncoming traffic has
   * pulled off onto, so the unit runs up the verge until it is past whatever is
   * parked there. Only the lateral move waits; it keeps making ground the whole
   * time.
   */
  mergeBack(unit, want) {
    if (Math.abs(unit.lateral) < this.route.roadHalfWidth - 1) return want;
    return this.laneClear(unit, want) ? want : unit.lateral;
  }

  /**
   * Stops a unit from driving through the load.
   *
   * Station keeping is a speed controller, and a speed controller will happily
   * walk a car straight into an 87 ft combination if the load slows down or the
   * unit is in a hurry. While a unit shares lane space with the load it is held
   * at whichever end of it the unit is on; it only gets past once it has
   * actually moved over.
   */
  separate(unit) {
    if (!unit.overlapsLaterally(this.loadLateral, this.loadHalfWidth)) return;

    const nose = this.convoyS + 1.5;
    const tail = this.convoyS - this.convoyLength - 1.5;
    const front = unit.s + unit.length * 0.5;
    const back = unit.s - unit.length * 0.5;
    if (front < tail || back > nose) return;   // already clear of the combination

    if (unit.s > (nose + tail) * 0.5) {
      // Ahead of the load: do not get run over by it.
      unit.s = nose + unit.length * 0.5;
      unit.speed = Math.max(unit.speed, this.convoySpeed);
    } else {
      // Behind it: sit on the tail until there is room to go by.
      unit.s = tail - unit.length * 0.5;
      unit.speed = Math.min(unit.speed, this.convoySpeed);
    }
  }

  updatePolice(dt, unit) {
    const b = unit.assignment;

    if (b && unit.state === 'advance') {
      // Move out into the closed lane, get by the load, then take up the
      // blocking position.
      const passing = unit.s < this.convoyS + 40;
      unit.targetLateral = this.mergeBack(
        unit, passing ? this.passLateral(unit) : this.route.laneWidth * 0.5);
      unit.lightsOn = true;

      const stopS = b.s - 6;
      unit.driveTo(dt, stopS, this.convoySpeed, 1.9);
      this.separate(unit);

      if (unit.s >= stopS - 12) {
        unit.state = 'blocking';
        b.active = true;
        b.populate();
        this.radio.say(this.unitName(unit),
          `${b.name} is blocked, cross traffic is stopped. You're clear through.`,
          { key: `blk${b.s}`, cooldown: 30, time: this.time });
      }
      return;
    }

    if (b && unit.state === 'blocking') {
      unit.lightsOn = true;
      // Sit across the mouth of the side road, once there is room to get over.
      const across = b.side * (this.route.roadHalfWidth + 1.5);
      unit.holdAt(dt, b.s, this.laneClear(unit, across) ? across : unit.lateral);
      return;
    }

    // No assignment: hold station, or catch back up after a release.
    const station = this.convoyS + this.stations[unit.role];
    const urgency = unit.state === 'rejoin' ? 1.8 : 1;
    // A unit coming back up from a released junction has the whole convoy and
    // the queue behind it in the way, so it makes the run in the closed lane and
    // only merges back once it is at its station.
    const overtaking = unit.state === 'rejoin' && unit.s < station - 10;
    unit.targetLateral = this.mergeBack(
      unit, overtaking ? this.passLateral(unit) : this.route.laneWidth * 0.5);
    unit.lightsOn = true;
    unit.driveTo(dt, station, this.convoySpeed, urgency);
    this.separate(unit);

    if (unit.state === 'rejoin' && Math.abs(unit.s - station) < 25) unit.state = 'station';
  }

  updatePilot(dt, unit) {
    const station = this.convoyS + this.stations[unit.role];
    unit.targetLateral = this.route.laneWidth * 0.5;
    unit.lightsOn = true;
    unit.driveTo(dt, station, this.convoySpeed, 1.1);
    this.separate(unit);
  }

  unitName(unit) {
    switch (unit.role) {
      case Role.LEAD_POLICE: return 'Unit 12';
      case Role.REAR_POLICE: return 'Unit 8';
      case Role.LEAD_PILOT: return 'Lead';
      case Role.REAR_PILOT: return 'Chase';
      default: return 'Escort';
    }
  }

  /**
   * Hazard calls from the lead car.
   *
   * The lead pilot is far enough ahead to see problems before the driver can,
   * and its height pole is the load's proxy for anything overhead.
   */
  callHazards() {
    const lead = this.leadPilot;
    const s = lead.s;

    const bridge = this.route.nextBridge(this.convoyS);
    if (bridge && bridge.s - s < 160 && bridge.s > s) {
      const key = `br${bridge.s}`;
      if (!this._announced.has(key)) {
        this._announced.add(key);
        const margin = bridge.clearance - this.loadHeight;
        if (margin < 0) {
          this.radio.say('Lead', `STOP. ${bridge.name} is ${bridge.clearance.toFixed(2)} m, you are ${this.loadHeight.toFixed(2)}. It will not go.`, { priority: 'critical', time: this.time });
        } else if (margin < 0.12) {
          this.radio.say('Lead', `${bridge.name}, ${bridge.clearance.toFixed(2)} m. That is only ${(margin * 100).toFixed(0)} cm. Walk it through at idle.`, { priority: 'warning', time: this.time });
        } else {
          this.radio.say('Lead', `${bridge.name} ahead, ${bridge.clearance.toFixed(2)} m posted. Pole is clear, you're good.`, { time: this.time });
        }
      }
    }

    const corner = this.route.nextTightCorner(this.convoyS);
    if (corner && corner.s - s < 200 && corner.s > s) {
      const key = `cn${corner.s}`;
      if (!this._announced.has(key)) {
        this._announced.add(key);
        this.radio.say('Lead',
          `${corner.name} coming up, ${corner.advisoryMph} mile an hour. You'll need the rear steer and the whole road.`,
          { priority: 'warning', time: this.time });
      }
    }

    const grade = this.route.gradeAt(this.convoyS);
    if (grade < -0.05) {
      this.radio.say('Lead', 'Long grade down. Get it in a low gear and stay off the service brakes.',
        { priority: 'warning', key: 'grade', cooldown: 90, time: this.time });
    }
  }

  /**
   * @param load  optional live geometry of the combination:
   *              { lateral, halfWidth, length } in route coordinates
   */
  update(dt, convoyS, convoySpeed, loadHeight, load = null) {
    this.time += dt;
    this.convoyS = convoyS;
    this.convoySpeed = Math.max(0, convoySpeed);
    this.loadHeight = loadHeight;
    this.poleHeight = loadHeight + 0.08;

    if (load) {
      if (Number.isFinite(load.lateral)) this.loadLateral = load.lateral;
      if (Number.isFinite(load.halfWidth)) this.loadHalfWidth = load.halfWidth;
      if (Number.isFinite(load.length)) this.convoyLength = load.length;
    }

    this.assignBlockades();

    for (const unit of this.vehicles) {
      if (unit.isPolice) this.updatePolice(dt, unit);
      else this.updatePilot(dt, unit);
    }

    for (const b of this.blockades) b.update();
    this.callHazards();
  }

  /** Blockade list in the shape TrafficManager expects. */
  get activeBlockades() {
    return this.blockades;
  }
}
