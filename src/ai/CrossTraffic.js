import { Vector3 } from 'three';

/**
 * Traffic on the cross street at a four-way intersection.
 *
 * A side road that is only ever a queue of parked cars is scenery. A crossroads
 * in town is not: the light cycles, cars come off the cross street and go
 * straight over the highway, and the reason the load can be walked through the
 * intersection at all is that a unit has taken the light and is holding every
 * one of them on the stop line.
 *
 * These vehicles are cheaper still than the ambient traffic on the highway --
 * they run along one axis, do not change lanes, and never leave the
 * intersection's neighbourhood -- but they follow each other, they obey the
 * signal, and they will not pull out in front of the load whatever the signal
 * says.
 */

const _tangent = new Vector3();
const _axis = new Vector3();

/** How far up the cross street vehicles are simulated, metres. */
const ARM = 95;

let nextId = 1;

/**
 * One vehicle on the cross street.
 *
 * It carries the same fields a `RoadPose` does -- position, pitch, wheel spin,
 * steer angle -- so the renderer can place it with exactly the code that places
 * everything else on the road, without a second path for a vehicle that happens
 * to be travelling across the route instead of along it.
 */
export class CrossVehicle {
  constructor(arm, u, kind) {
    this.id = nextId++;
    this.arm = arm;            // +1 approaches from the right of the route, -1 from the left
    this.u = u;                // signed distance from the intersection, along the cross street
    this.speed = 0;
    this.kind = kind;
    this.position = new Vector3();
    this.heading = 0;
    this.pitch = 0;
    this.steerAngle = 0;
    this.wheelSpin = 0;
    this.brakeLight = false;
    this.length = kind === 'truck' ? 8.5 : 4.6;
    this.wheelRadius = kind === 'truck' ? 0.46 : 0.34;
  }

  /** Distance still to run before it is clear of the intersection. */
  get toGo() {
    return this.arm > 0 ? this.u + ARM : ARM - this.u;
  }
}

export class CrossTraffic {
  /**
   * @param blockade the junction being held, which is also what stops them
   * @param route    the highway they are crossing
   */
  constructor(blockade, route) {
    this.blockade = blockade;
    this.route = route;
    this.junction = blockade.junction;
    this.s = blockade.s;
    this.vehicles = [];
    this.spawnTimer = Math.random() * 3;
    this.desiredSpeed = 13;    // ~30 mph on a residential cross street
    this.maxVehicles = 6;

    // Where the stop line sits, and how far a vehicle has to travel from it to
    // be clear of the far side of the highway.
    this.halfWidth = route.halfWidthAt(this.s);
    this.stopLine = this.halfWidth + 2.5;
    this.clearOfBox = this.halfWidth + 7;
  }

  /** True while anything is inside the intersection itself. */
  get occupied() {
    return this.vehicles.some((v) => Math.abs(v.u) < this.clearOfBox);
  }

  /**
   * @param dt
   * @param ctx { convoyS, convoySpeed, convoyLength, signal, held, active }
   */
  update(dt, ctx) {
    const { convoyS = -Infinity, convoySpeed = 0 } = ctx;

    // Only worth running when the convoy is close enough for it to be seen.
    const range = Math.abs(convoyS - this.s);
    if (range > 520) {
      if (this.vehicles.length) this.vehicles.length = 0;
      return;
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 2.5 + Math.random() * 4.5;
      this.spawn();
    }

    // Held by an officer, or by the light, or by the load itself. Any one of
    // them is enough to keep the stop line honoured.
    const signal = ctx.signal ?? null;
    const heldByUnit = !!ctx.held;
    const signalStop = signal ? signal.cross !== 'green' : false;

    // Even with a green and nobody holding it, nothing pulls out in front of an
    // 87 ft combination. The gap needed is the time for the load to arrive.
    const approach = convoyS - this.s;
    const loadEta = approach < 0 && convoySpeed > 0.5
      ? -approach / convoySpeed
      : Infinity;
    const loadInBox = approach > -this.clearOfBox - 20
      && approach < (ctx.convoyLength ?? 27) + this.clearOfBox + 10;
    const loadStop = loadInBox || loadEta < 12;

    const stop = heldByUnit || signalStop || loadStop;

    // Sort by how far each one still has to go so following works within an arm.
    for (const arm of [-1, 1]) {
      const list = this.vehicles
        .filter((v) => v.arm === arm)
        .sort((a, b) => a.toGo - b.toGo);

      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        const leader = list[i - 1] ?? null;

        let gap = Infinity;
        if (leader) gap = Math.abs(v.u - leader.u) - (v.length + leader.length) * 0.5;

        // Committed vehicles finish the crossing whatever changes behind them.
        const beforeLine = v.arm > 0 ? v.u > this.stopLine - 0.5 : v.u < -this.stopLine + 0.5;
        if (stop && beforeLine) {
          gap = Math.min(gap, Math.abs(v.u) - this.stopLine);
        }

        const target = this.desiredSpeed;
        let accel;
        if (gap < 60) {
          // Brake hard enough to stop in the gap, ease off as it opens.
          const need = (v.speed * v.speed) / (2 * Math.max(0.6, gap));
          accel = gap < 1.2 ? -8 : Math.min(2.2, (target - v.speed) * 0.8) - need;
        } else {
          accel = Math.min(2.2, (target - v.speed) * 0.8);
        }
        const prev = v.speed;
        v.speed = Math.max(0, Math.min(target, v.speed + accel * dt));
        v.brakeLight = v.speed < prev - 0.05;

        v.u -= v.arm * v.speed * dt;
        v.wheelSpin += (v.speed * dt) / v.wheelRadius;
      }
    }

    this.vehicles = this.vehicles.filter((v) => v.toGo > 0);
    this.place();
  }

  spawn() {
    if (this.vehicles.length >= this.maxVehicles) return null;
    const arm = Math.random() < 0.5 ? 1 : -1;
    // Not on top of anybody already waiting at the back of the queue.
    for (const v of this.vehicles) {
      if (v.arm === arm && Math.abs(v.u) > ARM - 18) return null;
    }
    const kind = Math.random() < 0.12 ? 'truck' : 'car';
    const v = new CrossVehicle(arm, arm * ARM, kind);
    v.speed = this.desiredSpeed * 0.8;
    this.vehicles.push(v);
    return v;
  }

  /** Puts every vehicle back into world space. */
  place() {
    const sample = this.route.at(this.s);
    _tangent.copy(sample.tangent);
    _axis.copy(sample.lateral);
    const laneOffset = 1.85;

    for (const v of this.vehicles) {
      // Travelling along -arm * axis, which puts its own lane arm * 1.85 along
      // the highway from the centre of the cross street.
      v.position.copy(sample.position)
        .addScaledVector(_axis, v.u)
        .addScaledVector(_tangent, v.arm * laneOffset);
      v.position.y = sample.position.y;
      v.heading = Math.atan2(-v.arm * _axis.x, -v.arm * _axis.z);
    }
  }
}
