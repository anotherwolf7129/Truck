/**
 * Drives one trailer over the whole permitted route, headlessly, and reports the
 * permit officer's sheet at the end of it.
 *
 * The mission test does this for the default trailer and asserts on the result.
 * This is the same run for any of them, printed rather than asserted, which is
 * how the per-trailer numbers in the README are measured: what each combination
 * does to the brakes on Prospect Hill, how close it comes to rolling on the loop
 * ramp, how much of itself ends up off the pavement at an intersection, and how
 * many centimetres it has under the rail bridge at Northgate.
 *
 *   node tools/haul.mjs              every trailer in the yard
 *   node tools/haul.mjs blade        just the one
 *
 * The driver is the same unremarkable autopilot the mission test uses: hold the
 * advisory speed, aim at the middle of the permitted lane, gear down and use the
 * compression brake on a descent. If a trailer cannot be delivered by that, it
 * cannot be delivered.
 */
import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { TRAILERS } from '../src/physics/Trailers.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';
import { ConvoyManager } from '../src/ai/Escort.js';
import { Scorecard } from '../src/mission/Scorecard.js';

function haul(id, { maxMinutes = 60 } = {}) {
  const route = new Route();
  const ground = new Ground(route);
  const rig = new Rig({ trailer: id });

  // Far enough in that the tail of the combination is on the route as well.
  const startS = Math.max(route.staging.s, rig.combinationLength + 30);
  rig.placeAt(
    route.positionAt(startS, route.convoyLaneOffset(startS), new Vector3()),
    route.headingAt(startS),
    ground
  );
  rig.air.psi = 120;
  rig.air.parkingBrake = false;

  const convoy = new ConvoyManager(route, rig);
  convoy.reset(startS);
  const card = new Scorecard(route, rig.loadHeight);

  const dt = 1 / 120;
  const proj = {};
  let offPavement = 0;

  for (let i = 0; i < Math.round((maxMinutes * 60) / dt); i++) {
    const p = rig.tractor.body.position;
    route.project(p.x, p.z, proj);
    const s = proj.s;

    let target = route.advisorySpeedAt(s);
    const lookahead = Math.min(260, 60 + Math.abs(rig.speedMph) * 6);
    for (let d = 20; d <= lookahead; d += 40) {
      target = Math.min(target, route.advisorySpeedAt(s + d) + 4);
    }
    const err = target - rig.speedMph;
    rig.throttle = Math.max(0, Math.min(1, err * 0.22));
    rig.brake = Math.max(0, Math.min(0.75, -err * 0.10));

    const grade = route.gradeAt(s);
    rig.powertrain.engineBrakeStage = grade < -0.03 ? 3 : 0;
    if (grade < -0.03) rig.brake = Math.min(rig.brake, 0.25);

    const aimS = s + Math.max(18, Math.abs(rig.speedMph) * 1.5);
    const aim = route.positionAt(aimS, route.convoyLaneOffset(aimS), new Vector3());
    const fwd = rig.tractor.body.localToWorldDir(new Vector3(0, 0, 1), new Vector3());
    const right = rig.tractor.body.localToWorldDir(new Vector3(-1, 0, 0), new Vector3());
    const toAim = aim.sub(p);
    rig.steerInput = Math.max(-1, Math.min(1,
      Math.atan2(toAim.dot(right), Math.max(1, toAim.dot(fwd))) * 2.2));

    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, ground);

    convoy.update(dt, s, rig.tractor.forwardSpeed, rig.loadHeight, {
      lateral: proj.lateral,
      halfWidth: rig.cargo.size.x * 0.5,
      length: rig.combinationLength,
    });
    card.observe(dt, rig, convoy, s, proj.lateral);

    // How far the worst-placed unit got outside the paved width. On the tight
    // intersections these corners are taken using all of the pavement, so what
    // matters is whether anything ended up past the edge of it.
    for (const u of rig.units) {
      const q = route.project(u.body.position.x, u.body.position.z, {});
      offPavement = Math.max(offPavement, Math.abs(q.lateral) - route.halfWidthAt(q.s));
    }

    if (s >= route.destination.s) { card.finish('delivered'); break; }
    if (rig.telemetry.rollover >= 1.4) { card.finish('rolled'); break; }
  }

  return { rig, report: card.report, grade: card.grade, offPavement, junctions: route.junctions.length };
}

const only = process.argv[2];
const list = only ? TRAILERS.filter((t) => t.id === only) : TRAILERS;
if (!list.length) {
  console.log(`no such trailer: ${only}\nknown: ${TRAILERS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

console.log(
  '\ntrailer     gross        length  outcome     min   rollover  brakes  '
  + 'off pavement  clearance  junctions\n'
);
for (const spec of list) {
  const { rig, report: r, grade, offPavement, junctions } = haul(spec.id);
  console.log(
    `${spec.id.padEnd(11)}`
    + `${Math.round(rig.grossWeightLb).toLocaleString().padStart(9)} lb`
    + `${(rig.combinationLength * 3.28084).toFixed(0).padStart(6)} ft  `
    + `${(r.outcome ?? 'timed out').padEnd(11)}`
    + `${r.minutes.toFixed(0).padStart(3)}`
    + `${r.peakRollover.toFixed(2).padStart(10)}`
    + `${r.peakBrakeC.toFixed(0).padStart(7)}C`
    + `${offPavement.toFixed(1).padStart(11)} m`
    + `${(r.lowestClearanceMargin * 100).toFixed(0).padStart(9)} cm`
    + `${`${r.junctionsBlocked}/${junctions}`.padStart(11)}`
    + `   ${grade}`
  );
}
console.log();
