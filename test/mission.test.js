import test from 'node:test';
import assert from 'node:assert';
import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';
import { ConvoyManager } from '../src/ai/Escort.js';
import { TrafficManager } from '../src/ai/Traffic.js';
import { Scorecard } from '../src/mission/Scorecard.js';

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
function runMission({ maxMinutes = 45, useEngineBrake = true } = {}) {
  const route = new Route();
  const ground = new Ground(route);
  const rig = new Rig({
    cargo: {
      name: 'Substation transformer, 400 MVA',
      mass: 68000,
      size: new Vector3(3.66, 3.60, 8.40),
      centerHeight: 2.35,
    },
  });
  const loadHeight = 0.55 + rig.cargo.size.y;

  const startS = route.staging.s;
  rig.placeAt(
    route.positionAt(startS, route.convoyLaneOffset(startS), new Vector3()),
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

  // The same accumulator the game scores the player's run with, so the numbers
  // asserted here are exactly the ones the debrief screen reports.
  const card = new Scorecard(route, loadHeight);
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

    // Steer toward a point up the road in the middle of the permitted lane --
    // which through town is the inside one, on the far side of the turn lane.
    const aimS = s + Math.max(18, Math.abs(rig.speedMph) * 1.5);
    const aim = route.positionAt(aimS, route.convoyLaneOffset(aimS), new Vector3());
    const fwd = rig.tractor.body.localToWorldDir(new Vector3(0, 0, 1), new Vector3());
    // Facing +Z in a right-handed frame, the rig's right-hand side is -X.
    const right = rig.tractor.body.localToWorldDir(new Vector3(-1, 0, 0), new Vector3());
    const toAim = aim.sub(p);
    const steer = Math.atan2(toAim.dot(right), Math.max(1, toAim.dot(fwd)));
    rig.steerInput = Math.max(-1, Math.min(1, steer * 2.2));

    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, ground);

    const speed = rig.tractor.forwardSpeed;
    convoy.update(dt, s, speed, loadHeight, {
      lateral: proj.lateral,
      halfWidth: rig.cargo.size.x * 0.5,
      length: 27,
    });
    traffic.update(dt, {
      convoy: { s, speed, lateral: proj.lateral, halfWidth: rig.cargo.size.x * 0.5, length: 27 },
      escorts: convoy.vehicles,
      blockades: convoy.blockades,
      route,
    });

    // --- Observations -------------------------------------------------------
    card.observe(dt, rig, convoy, s, proj.lateral);

    if (s >= route.destination.s) { card.finish('delivered'); break; }
    if (rig.telemetry.rollover >= 1.4) { card.finish('rolled'); break; }
  }

  return card.report;
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
  console.log(`  max lateral excursion ${mission.maxOffRoute.toFixed(1)} m from the permitted lane`);
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

test('a unit has the light at every signal on the route', () => {
  // The reason a unit runs ahead to a signalised junction is that the load must
  // never meet a red. Stopping 212,000 lb at a light is not a delay, it is a
  // standing start on whatever grade the light happens to be on.
  console.log(
    `  ${mission.signalsHeld} signals green` +
    (mission.signalsRun.length ? `, RAN: ${mission.signalsRun.join(', ')}` : '')
  );
  assert.ok(mission.signalsHeld >= 4, `only ${mission.signalsHeld} signals were green for the load`);
  assert.deepStrictEqual(mission.signalsRun, []);
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
