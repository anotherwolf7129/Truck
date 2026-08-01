import test from 'node:test';
import assert from 'node:assert';
import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';
import { ConvoyManager } from '../src/ai/Escort.js';
import { TrafficManager } from '../src/ai/Traffic.js';

/**
 * End-to-end: drive the whole permitted route with a simple autopilot and check
 * that the move is actually completable -- the rig stays upright, stays on the
 * road, keeps its brakes alive down the grade, and the escorts block every
 * junction before the load reaches it.
 *
 * The autopilot here is deliberately unremarkable: hold the advisory speed,
 * steer at the centre of the lane, gear down on descents. If a competent but
 * unexceptional driver cannot get the load there, the route is not fair.
 */
function runMission({ maxMinutes = 45, useEngineBrake = true, trailer = 'lowboy4' } = {}) {
  const route = new Route();
  const ground = new Ground(route);
  const rig = new Rig({ trailer });
  const loadHeight = rig.loadHeight;

  const startS = route.staging.s;
  rig.placeAt(
    route.positionAt(startS, route.laneWidth * 0.5, new Vector3()),
    route.headingAt(startS),
    ground
  );
  rig.air.psi = 120;
  rig.air.parkingBrake = false;

  const convoy = new ConvoyManager(route, rig);
  const traffic = new TrafficManager(route, { density: 1 });
  convoy.reset(startS);

  const dt = 1 / 120;
  const steps = Math.floor((maxMinutes * 60) / dt);

  const report = {
    completed: false,
    minutes: 0,
    peakRollover: 0,
    peakJackknife: 0,
    peakBrakeC: 0,
    minPsi: 999,
    maxOffRoute: 0,
    junctionsBlocked: 0,
    junctionsMissed: [],
    lowestClearanceMargin: Infinity,
    distanceMi: 0,
  };
  const seenJunctions = new Set();
  const proj = {};

  for (let i = 0; i < steps; i++) {
    const p = rig.tractor.body.position;
    route.project(p.x, p.z, proj);
    const s = proj.s;

    // --- Autopilot ---------------------------------------------------------
    // Look ahead far enough to slow for what is coming, not what is here. A
    // loaded rig needs several hundred feet to lose ten miles an hour.
    const lookahead = Math.min(260, 60 + Math.abs(rig.speedMph) * 6);
    let target = route.advisorySpeedAt(s);
    for (let d = 20; d <= lookahead; d += 40) {
      target = Math.min(target, route.advisorySpeedAt(s + d) + 4);
    }

    const err = target - rig.speedMph;
    rig.throttle = Math.max(0, Math.min(1, err * 0.22));
    rig.brake = Math.max(0, Math.min(0.75, -err * 0.10));

    // On a sustained descent the compression brake does the work; the service
    // brakes are only there to trim.
    const grade = route.gradeAt(s);
    rig.powertrain.engineBrakeStage = useEngineBrake && grade < -0.03 ? 3 : 0;
    if (useEngineBrake && grade < -0.03) rig.brake = Math.min(rig.brake, 0.25);

    // Steer toward a point up the road in the middle of the lane.
    const aimS = s + Math.max(18, Math.abs(rig.speedMph) * 1.5);
    const aim = route.positionAt(aimS, route.laneWidth * 0.5, new Vector3());
    const fwd = rig.tractor.body.localToWorldDir(new Vector3(0, 0, 1), new Vector3());
    // The vehicle's right-hand side is -X: +Z forward with +Y up in a
    // right-handed frame puts +X on the left.
    const right = rig.tractor.body.localToWorldDir(new Vector3(-1, 0, 0), new Vector3());
    const toAim = aim.sub(p);
    const steer = Math.atan2(toAim.dot(right), Math.max(1, toAim.dot(fwd)));
    rig.steerInput = Math.max(-1, Math.min(1, steer * 2.2));

    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, ground);

    const speed = rig.tractor.forwardSpeed;
    convoy.update(dt, s, speed, loadHeight);
    traffic.update(dt, {
      convoy: { s, speed, length: rig.combinationLength },
      blockades: convoy.blockades,
      route,
    });

    // --- Observations -------------------------------------------------------
    report.peakRollover = Math.max(report.peakRollover, rig.telemetry.rollover);
    report.peakJackknife = Math.max(report.peakJackknife, rig.telemetry.jackknife);
    report.peakBrakeC = Math.max(report.peakBrakeC, rig.telemetry.brakeTempC);
    report.minPsi = Math.min(report.minPsi, rig.air.psi);
    report.maxOffRoute = Math.max(report.maxOffRoute, Math.abs(proj.lateral));

    for (const b of convoy.blockades) {
      if (!seenJunctions.has(b.name) && s > b.s - 5) {
        seenJunctions.add(b.name);
        if (b.active) report.junctionsBlocked++;
        else report.junctionsMissed.push(b.name);
      }
    }
    for (const bridge of route.bridges) {
      if (Math.abs(bridge.s - s) < 12) {
        report.lowestClearanceMargin = Math.min(
          report.lowestClearanceMargin,
          bridge.clearance - loadHeight
        );
      }
    }

    report.minutes = (i * dt) / 60;
    report.distanceMi = s / 1609.34;

    if (s >= route.destination.s) { report.completed = true; break; }
    if (rig.telemetry.rollover >= 1.4) break;   // on its side, move over
  }

  return report;
}

let mission;
test('the permitted move can actually be completed', () => {
  mission = runMission();
  console.log(
    `  delivered=${mission.completed} in ${mission.minutes.toFixed(0)} min ` +
    `(${mission.distanceMi.toFixed(2)} mi)`
  );
  assert.ok(mission.completed, `only reached ${mission.distanceMi.toFixed(2)} mi`);
});

test('the load stays upright and the rig never jackknifes', () => {
  console.log(
    `  peak rollover ${mission.peakRollover.toFixed(2)}, ` +
    `peak jackknife ${mission.peakJackknife.toFixed(2)}`
  );
  assert.ok(mission.peakRollover < 1.0, `rolled the load (${mission.peakRollover.toFixed(2)})`);
  assert.ok(mission.peakJackknife < 0.9, `jackknifed (${mission.peakJackknife.toFixed(2)})`);
});

test('stays inside the permitted corridor', () => {
  console.log(`  max lateral excursion ${mission.maxOffRoute.toFixed(1)} m from centreline`);
  assert.ok(mission.maxOffRoute < 8, `wandered ${mission.maxOffRoute.toFixed(1)} m off centre`);
});

test('the load clears every bridge on the route', () => {
  const m = mission.lowestClearanceMargin;
  console.log(`  tightest bridge clearance: ${(m * 100).toFixed(0)} cm`);
  assert.ok(m > 0, 'the load did not fit under a bridge on its own permitted route');
  assert.ok(m < 1.0, 'no bridge on the route is tight enough to matter');
});

test('escorts block every junction before the load arrives', () => {
  console.log(
    `  ${mission.junctionsBlocked} blocked` +
    (mission.junctionsMissed.length ? `, MISSED: ${mission.junctionsMissed.join(', ')}` : '')
  );
  assert.deepStrictEqual(mission.junctionsMissed, []);
  assert.ok(mission.junctionsBlocked >= 8, `only ${mission.junctionsBlocked} junctions blocked`);
});

test('air pressure survives the descent', () => {
  console.log(`  lowest air pressure ${mission.minPsi.toFixed(0)} psi, peak brake ${mission.peakBrakeC.toFixed(0)} C`);
  assert.ok(mission.minPsi > 60, `ran the air down to ${mission.minPsi.toFixed(0)} psi`);
});

test('riding the service brakes down the grade cooks them', () => {
  // The compression brake is not optional equipment on this route. Without it
  // the drums should get into fade territory, which is the whole lesson of the
  // nine percent grade.
  const withJake = mission.peakBrakeC;
  const without = runMission({ useEngineBrake: false, maxMinutes: 45 }).peakBrakeC;
  console.log(`  peak brake temp: ${withJake.toFixed(0)} C with engine brake, ${without.toFixed(0)} C without`);
  assert.ok(without > withJake + 40,
    `engine brake made no meaningful difference (${withJake.toFixed(0)} vs ${without.toFixed(0)} C)`);
});

// --- Every trailer configuration has to be drivable -------------------------

test('each trailer configuration can complete the route', async () => {
  const { TRAILER_CONFIGS } = await import('../src/physics/Trailers.js');
  for (const config of TRAILER_CONFIGS) {
    const r = runMission({ trailer: config.id, maxMinutes: 45 });
    console.log(
      `  ${config.name.padEnd(24)} delivered=${r.completed} ` +
      `${r.minutes.toFixed(0)} min, rollover ${r.peakRollover.toFixed(2)}, ` +
      `jackknife ${r.peakJackknife.toFixed(2)}, ${r.junctionsBlocked} junctions blocked`
    );
    assert.ok(r.completed, `${config.name} only reached ${r.distanceMi.toFixed(2)} mi`);
    assert.ok(r.peakRollover < 1.0, `${config.name} rolled the load`);
    assert.ok(r.peakJackknife < 0.9, `${config.name} jackknifed`);
    assert.deepStrictEqual(r.junctionsMissed, [], `${config.name} missed a junction`);
  }
});

test('every configuration loads its axles sensibly', async () => {
  const { TRAILER_CONFIGS, loadSplit } = await import('../src/physics/Trailers.js');
  for (const c of TRAILER_CONFIGS) {
    const s = loadSplit(c);
    const perWheelLb = s.perWheelN * 0.2248089431;
    console.log(`  ${c.name.padEnd(24)} ${Math.round(perWheelLb).toLocaleString()} lb per wheel position, gooseneck ${(s.gooseneckFraction*100).toFixed(0)}%`);
    // A dual position carries two tires; much over 12,000 lb and the tires are
    // past their rating, much under 5,000 and the axles are pointless weight.
    assert.ok(perWheelLb > 5000 && perWheelLb < 13000,
      `${c.name}: ${Math.round(perWheelLb)} lb per wheel is not a sane axle load`);
    // The gooseneck has to carry a real share or the tractor has no traction.
    assert.ok(s.gooseneckFraction > 0.35 && s.gooseneckFraction < 0.60,
      `${c.name}: gooseneck carries ${(s.gooseneckFraction*100).toFixed(0)}%`);
  }
});
