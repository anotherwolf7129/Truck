import test from 'node:test';
import assert from 'node:assert';
import { Vector3 } from 'three';
import { Route } from '../src/world/Route.js';
import { Rig } from '../src/physics/Rig.js';
import { ConvoyManager } from '../src/ai/Escort.js';
import { Scorecard, Verdict } from '../src/mission/Scorecard.js';
import { Game } from '../src/Game.js';

/**
 * The scorecard is the one piece of the game layer the mission test and the
 * player-facing debrief share, so it is worth checking on its own rather than
 * only through a forty-minute integration run.
 */

const route = new Route();

/** A rig-shaped stub, so a scored run does not need the physics to be stepped. */
function fakeRig({ rollover = 0, jackknife = 0, brakeC = 60, psi = 110, clutchC = 40, contact = 0 }) {
  return {
    telemetry: { rollover, jackknife, brakeTempC: brakeC },
    air: { psi },
    powertrain: { clutchTempC: clutchC, overRevDamage: 0 },
    units: [{ chassisContact: contact }],
  };
}

function fakeConvoy(activeNames = []) {
  return {
    blockades: route.junctions.map((j) => ({
      name: j.name,
      s: j.s,
      active: activeNames === 'all' || activeNames.includes(j.name),
    })),
  };
}

test('a clean run scores as delivered and passes every line', () => {
  const card = new Scorecard(route, 4.15);
  const convoy = fakeConvoy('all');
  const rig = fakeRig({ rollover: 0.29, jackknife: 0.02, brakeC: 145, psi: 100, clutchC: 60 });

  // Walk the whole route so every junction and bridge is judged.
  for (let s = 0; s <= route.destination.s; s += 10) {
    card.observe(1 / 60, rig, convoy, s, 1.85);
  }
  card.finish('delivered');
  const r = card.report;

  console.log(
    `  delivered=${r.completed}, grade=${card.grade}, ` +
    `${r.junctionsBlocked}/${route.junctions.length} junctions, ` +
    `tightest bridge ${(r.lowestClearanceMargin * 100).toFixed(0)} cm`
  );

  assert.ok(r.completed);
  assert.strictEqual(card.grade, Verdict.PASS, 'a clean run should not be flagged');
  assert.deepStrictEqual(r.junctionsMissed, []);
  assert.strictEqual(r.junctionsBlocked, route.junctions.length);
  assert.ok(r.lowestClearanceMargin > 0, 'the load should have fitted under every bridge');
  assert.strictEqual(r.chassisStrikes, 0);
});

test('rolling the load fails the move outright', () => {
  const card = new Scorecard(route, 4.15);
  const convoy = fakeConvoy('all');
  card.observe(1 / 60, fakeRig({ rollover: 1.45 }), convoy, 4800, 2.0);
  card.finish('rolled');

  assert.strictEqual(card.completed, false);
  assert.strictEqual(card.grade, Verdict.FAIL);
  assert.match(card.verdictText, /went over/);
});

test('a missed junction and cooked brakes are both flagged', () => {
  const card = new Scorecard(route, 4.15);
  // Everything blocked except the first junction.
  const convoy = fakeConvoy(route.junctions.slice(1).map((j) => j.name));
  const rig = fakeRig({ brakeC: 430, psi: 75, contact: 0.02 });

  for (let s = 0; s <= route.destination.s; s += 10) {
    card.observe(1 / 60, rig, convoy, s, 1.85);
  }
  card.finish('delivered');
  const r = card.report;

  console.log(`  missed ${r.junctionsMissed.join(', ')}, brakes ${r.peakBrakeC.toFixed(0)} C`);

  assert.deepStrictEqual(r.junctionsMissed, [route.junctions[0].name]);
  assert.strictEqual(card.grade, Verdict.FAIL);

  const byLabel = Object.fromEntries(card.lines.map((l) => [l.label, l.verdict]));
  assert.strictEqual(byLabel['Junctions held'], Verdict.FAIL);
  assert.strictEqual(byLabel.Brakes, Verdict.FAIL);
  assert.strictEqual(byLabel['Air system'], Verdict.WARN);
});

test('a chassis strike is counted once per contact, not once per frame', () => {
  const card = new Scorecard(route, 4.15);
  const convoy = fakeConvoy([]);
  const down = fakeRig({ contact: 0.03 });
  const up = fakeRig({ contact: 0 });

  // Two separate touchdowns, each lasting many frames.
  for (let i = 0; i < 30; i++) card.observe(1 / 60, down, convoy, 100 + i, 0);
  for (let i = 0; i < 30; i++) card.observe(1 / 60, up, convoy, 200 + i, 0);
  for (let i = 0; i < 30; i++) card.observe(1 / 60, down, convoy, 300 + i, 0);

  assert.strictEqual(card.report.chassisStrikes, 2);
});

test('teleporting up the route does not fail the junctions that were skipped', () => {
  // `jumpTo` exists to inspect the switchback or the grade without driving the
  // seven miles first. Everything behind the jump was never driven, so it must
  // not be scored -- otherwise the card reports a wall of failures for road the
  // player never saw.
  const convoy = fakeConvoy([]);   // nothing blocked, since no unit was sent

  // Past the last junction on the route: nothing left to hold, nothing to miss.
  const card = new Scorecard(route, 4.15);
  const past = route.junctions[route.junctions.length - 1].s + 60;
  card.skipTo(past);
  for (let s = past; s <= route.destination.s; s += 10) {
    card.observe(1 / 60, fakeRig({}), convoy, s, 1.85);
  }
  card.finish('delivered');

  console.log(`  jumped to ${past.toFixed(0)} m: missed ${card.report.junctionsMissed.length} junctions`);
  assert.deepStrictEqual(card.report.junctionsMissed, [],
    'junctions behind the jump should not be judged');

  // Junctions genuinely ahead of the jump are still judged as normal.
  const from = route.junctions[route.junctions.length - 3].s - 60;
  const ahead = route.junctions.filter((j) => j.s > from);
  assert.ok(ahead.length >= 3, 'the fixture needs junctions ahead of the jump');
  const late = new Scorecard(route, 4.15);
  late.skipTo(from);
  for (let s = from; s <= route.length; s += 10) {
    late.observe(1 / 60, fakeRig({}), convoy, s, 1.85);
  }
  assert.deepStrictEqual(late.report.junctionsMissed, ahead.map((j) => j.name),
    'junctions ahead of the jump must still be scored');
});

test('the scorecard stops recording once the move is over', () => {
  const card = new Scorecard(route, 4.15);
  const convoy = fakeConvoy([]);
  card.observe(1 / 60, fakeRig({ rollover: 0.3 }), convoy, 100, 0);
  card.finish('delivered');
  card.observe(1 / 60, fakeRig({ rollover: 1.2 }), convoy, 200, 0);

  assert.ok(Math.abs(card.peakRollover - 0.3) < 1e-9,
    'observations after the move ended should not change the record');
});

/**
 * The vehicle mesh pool.
 *
 * Traffic recycles continuously for the whole move and every mesh owns its own
 * geometry, so meshes have to come back rather than being dropped. Exercised
 * against the real Game methods with a stub scene, since a WebGL context is not
 * available headlessly.
 */
test('retired traffic meshes are reused instead of accumulating', () => {
  const scene = { children: [], add(m) { this.children.push(m); m.parent = this; }, remove() {} };
  const game = Object.create(Game.prototype);
  game.vehiclePool = new Map();
  game.render = { scene };

  const first = game.acquireVehicle('car', 0.2);
  const second = game.acquireVehicle('car', 0.6);
  assert.notStrictEqual(first, second, 'two live vehicles must not share one mesh');
  assert.strictEqual(scene.children.length, 2);

  game.releaseVehicle('car', first);
  assert.strictEqual(first.visible, false, 'a retired mesh should be hidden');

  const third = game.acquireVehicle('car', 0.9);
  assert.strictEqual(third, first, 'the retired mesh should have been reused');
  assert.strictEqual(third.visible, true);
  assert.strictEqual(scene.children.length, 2, 'reuse must not add another mesh to the scene');

  // Kinds are pooled separately -- a car must never come back as a truck.
  const truck = game.acquireVehicle('truck', 0.1);
  assert.notStrictEqual(truck, first);
  assert.strictEqual(scene.children.length, 3);

  // With every vehicle handed back, churning through forty more must not
  // allocate a single additional mesh.
  game.releaseVehicle('car', second);
  game.releaseVehicle('car', third);
  game.releaseVehicle('truck', truck);
  const peak = scene.children.length;

  for (let cycle = 0; cycle < 40; cycle++) {
    const a = game.acquireVehicle('car', cycle / 40);
    const b = game.acquireVehicle('truck', cycle / 40);
    game.releaseVehicle('car', a);
    game.releaseVehicle('truck', b);
  }
  console.log(`  40 recycles later: ${scene.children.length} meshes in the scene (peak ${peak})`);
  assert.strictEqual(scene.children.length, peak, 'the pool should be reusing, not allocating');
});

/** Guards the wiring the debrief and the audio chirp both depend on. */
test('radio listeners are hooked up for the whole convoy', () => {
  const convoy = new ConvoyManager(route, new Rig({
    cargo: { name: 'test', mass: 68000, size: new Vector3(3.66, 3.6, 8.4), centerHeight: 2.35 },
  }));
  const heard = [];
  convoy.radio.listeners.push((m) => heard.push(m));
  convoy.radio.say('Lead', 'bridge ahead', { priority: 'warning', time: 1 });

  assert.strictEqual(heard.length, 1);
  assert.strictEqual(heard[0].priority, 'warning');
});
