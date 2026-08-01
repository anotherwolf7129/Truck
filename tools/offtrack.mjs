import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';

/**
 * How far inside the tractor's path does the trailer's tail run?
 *
 * Measured through the switchback, which is the tightest thing on the route.
 * Lower is better: it is the difference between the load staying in its lane
 * and the load going through the ditch on the inside of the corner.
 */
const route = new Route(), ground = new Ground(route);

function run(gain) {
  const rig = new Rig();
  rig.autoTrailerSteer = gain !== null;
  if (gain !== null) rig.trailerSteerGain = gain;
  const s0 = 4600;
  rig.placeAt(route.positionAt(s0, route.laneWidth*0.5, new Vector3()), route.headingAt(s0), ground);
  rig.air.psi = 120; rig.air.parkingBrake = false;
  const dt = 1/200;
  const v = 9/2.23694;
  const dir = new Vector3(Math.sin(route.headingAt(s0)),0,Math.cos(route.headingAt(s0)));
  for (const u of rig.units) { u.body.velocity.copy(dir).multiplyScalar(v); for (const w of u.wheels) w.spin = v/w.radius; }
  rig.powertrain.gear = 6;
  for (let i=0;i<300;i++) rig.step(dt, ground);

  // Record where the tractor was at each point along the route, then compare
  // the tail's position at the SAME point. That is off-tracking proper, rather
  // than a measure of how well the autopilot held its lane.
  const tractorPath = new Map();
  let worst = 0, worstTractor = 0;
  for (let i=0;i<200*90;i++) {
    const p = rig.tractor.body.position;
    const pr = route.project(p.x, p.z);
    if (pr.s > 5150) break;
    // Autopilot: hold the lane at the advisory speed.
    const target = route.advisorySpeedAt(pr.s);
    const err = target - rig.speedMph;
    rig.throttle = Math.max(0, Math.min(1, err*0.25));
    rig.brake = Math.max(0, Math.min(0.6, -err*0.12));
    const aim = route.positionAt(pr.s + Math.max(14, Math.abs(rig.speedMph)*1.3), route.laneWidth*0.5, new Vector3());
    const fwd = rig.tractor.body.localToWorldDir(new Vector3(0,0,1), new Vector3());
    const right = rig.tractor.body.localToWorldDir(new Vector3(-1,0,0), new Vector3());
    const toAim = aim.sub(p);
    rig.steerInput = Math.max(-1, Math.min(1, Math.atan2(toAim.dot(right), Math.max(1, toAim.dot(fwd)))*2.4));
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, ground);

    tractorPath.set(Math.round(pr.s), pr.lateral);

    const tail = rig.trailer.body.localToWorld(new Vector3(0, 0, -9.0), new Vector3());
    const tp = route.project(tail.x, tail.z);
    const tractorHere = tractorPath.get(Math.round(tp.s));
    if (tractorHere !== undefined) {
      worst = Math.max(worst, Math.abs(tp.lateral - tractorHere));
    }
    worstTractor = Math.max(worstTractor, Math.abs(pr.lateral - route.laneWidth*0.5));
  }
  return { worst, worstTractor };
}

console.log('Trailer off-tracking through the 159 m switchback (lower is better):\n');
for (const gain of [null, -1.6, 0.8, 1.6, 2.4, 3.2, 4.0]) {
  const r = run(gain);
  const label = gain === null ? 'command steer OFF' : `gain ${gain.toFixed(1)}`;
  console.log(`  ${label.padEnd(18)} tail ${r.worst.toFixed(2)} m off lane centre  (tractor ${r.worstTractor.toFixed(2)} m)`);
}
