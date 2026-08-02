import test from 'node:test';
import assert from 'node:assert';
import { Route } from '../src/world/Route.js';
import { Corridor } from '../src/world/Corridor.js';
import { TrafficSignal, SignalNetwork, Phase } from '../src/world/Signal.js';

/**
 * The road itself: how wide it is, how many lanes it has, where those lanes
 * are, and what the lights on it are doing.
 *
 * These are the numbers everything else on the route is derived from -- where
 * the traffic sits, where the escorts ride, how far off centre counts as off the
 * road -- so they are worth pinning down directly rather than only through the
 * behaviour that comes out of them.
 */

const route = new Route();

test('the route is more than one road', () => {
  const kinds = new Set();
  for (let s = 0; s < route.length; s += 50) kinds.add(route.kindAt(s));
  console.log(`  ${[...kinds].join(', ')}`);
  assert.ok(kinds.has('rural'), 'no two-lane county road');
  assert.ok(kinds.has('suburban'), 'the route never reaches town');
  assert.ok(kinds.size >= 3, 'the whole route is the same kind of road');
});

/** The middle of the section the corridor calls by this name. */
function midOf(kind) {
  const sections = route.corridor.sections;
  const i = sections.findIndex((sec) => sec.kind === kind);
  assert.ok(i >= 0, `no ${kind} section on the route`);
  const end = sections[i + 1] ? sections[i + 1].s : route.length;
  return (sections[i].s + end) / 2;
}

test('the town has two lanes each way and a turn lane between them', () => {
  const townS = midOf('suburban');
  assert.strictEqual(route.kindAt(townS), 'suburban');
  assert.strictEqual(route.laneCountAt(townS), 2);
  assert.ok(route.medianAt(townS) > 3, 'no centre turn lane through town');

  // The county road is what it always was.
  const ruralS = midOf('rural');
  assert.strictEqual(route.laneCountAt(ruralS), 1);
  assert.strictEqual(route.medianAt(ruralS), 0);
  assert.strictEqual(route.convoyLaneOffset(ruralS).toFixed(2), (route.laneWidth * 0.5).toFixed(2));
});

test('lanes are laid out side by side without overlapping', () => {
  // Every station on the route rather than a handful of remembered ones: the
  // cross-section changes at a dozen places now, and half of them are the turn
  // widening either side of a corner.
  for (let s = 0; s <= route.length; s += 25) {
    const count = route.laneCountAt(s);
    const edge = route.edgeOffsetAt(s);
    for (const dir of [1, -1]) {
      for (let i = 0; i < count; i++) {
        const offset = route.laneOffsetAt(s, dir, i);
        assert.strictEqual(Math.sign(offset), dir, `lane ${i} is on the wrong side of the road at ${s}`);
        assert.ok(Math.abs(offset) + route.laneWidth * 0.5 <= edge + 1e-6,
          `lane ${i} runs off the pavement at ${s}`);
        if (i > 0) {
          const inner = route.laneOffsetAt(s, dir, i - 1);
          assert.ok(Math.abs(Math.abs(offset) - Math.abs(inner) - route.laneWidth) < 1e-6,
            'lanes are not one lane width apart');
        }
      }
    }
    assert.ok(route.halfWidthAt(s) > edge, `no shoulder at ${s}`);
  }
});

test('the road widens over a taper rather than in one step', () => {
  // The pavement has to grow smoothly -- a step in the road edge is a step in
  // the terrain skirt and in what counts as off the road -- while the extra lane
  // only opens once there is a whole one of it.
  const townLine = route.corridor.sections.find((sec) => sec.kind === 'suburban').s;
  let maxJump = 0;
  let opened = null;
  for (let s = townLine - 300; s < townLine + 300; s += 2) {
    const jump = Math.abs(route.halfWidthAt(s) - route.halfWidthAt(s - 2));
    maxJump = Math.max(maxJump, jump);
    if (opened === null && route.laneCountAt(s) > 1) opened = s;
  }
  console.log(`  second lane opens at ${opened} m, widest step ${(maxJump * 100).toFixed(1)} cm per 2 m`);
  assert.ok(maxJump < 0.12, `the pavement edge jumps ${maxJump.toFixed(2)} m in two metres`);
  assert.ok(opened !== null, 'the second lane never opened');
  // Full width by the time the lane is usable, not before.
  assert.ok(route.laneCountAt(opened - 20) === 1, 'the lane opened before the taper finished');
});

test('the advisory speed never exceeds the posted limit', () => {
  let worst = 0;
  for (let s = 0; s < route.length; s += 25) {
    const over = route.advisorySpeedAt(s) - route.speedLimitAt(s);
    worst = Math.max(worst, over);
  }
  console.log(`  worst case: ${worst.toFixed(1)} mph over the sign`);
  assert.ok(worst <= 0.001, `the load is advised ${worst.toFixed(1)} mph over the posted limit`);
});

test('a corridor blends between sections from both directions consistently', () => {
  const c = new Corridor([
    { s: 0, name: 'a', kind: 'rural', lanes: 1, median: 0, shoulder: 2.4, limitMph: 45 },
    { s: 1000, name: 'b', kind: 'suburban', lanes: 2, median: 3.7, shoulder: 1.6, limitMph: 35, taper: 100 },
  ]);
  const before = c.at(999.9);
  const after = c.at(1000.1);
  assert.ok(Math.abs(before.lanes - after.lanes) < 0.01, 'the taper is discontinuous at the boundary');
  assert.ok(Math.abs(before.median - after.median) < 0.01);
  assert.strictEqual(c.at(940).lanes, 1, 'the taper starts too early');
  assert.strictEqual(c.at(1060).lanes, 2, 'the taper ends too late');
  assert.ok(c.at(1000).lanes > 1.4 && c.at(1000).lanes < 1.6, 'the boundary is not the middle of the taper');
});

test('a signal cycle gives every approach a turn and never two at once', () => {
  const signal = new TrafficSignal({ s: 0, name: 'test' }, { offset: 0 });
  const seen = { mainline: new Set(), cross: new Set() };
  let conflicts = 0;
  for (let t = 0; t < signal.cycle; t += 0.1) {
    if (signal.mainline === Phase.GREEN && signal.cross !== Phase.RED) conflicts++;
    if (signal.cross === Phase.GREEN && signal.mainline !== Phase.RED) conflicts++;
    seen.mainline.add(signal.mainline);
    seen.cross.add(signal.cross);
    signal.update(0.1);
  }
  console.log(`  ${signal.cycle.toFixed(0)} s cycle, ${conflicts} conflicting frames`);
  assert.strictEqual(conflicts, 0, 'the signal gave two conflicting approaches a green');
  assert.strictEqual(seen.mainline.size, 3, 'the highway never saw all three phases');
  assert.strictEqual(seen.cross.size, 3, 'the cross street never saw all three phases');
});

test('a preempted signal holds the highway green and everybody else red', () => {
  const signal = new TrafficSignal({ s: 0, name: 'test' }, { offset: 0 });
  // Wind it to the middle of the cross street's green, which is the worst case.
  while (signal.cross !== Phase.GREEN) signal.update(0.5);

  signal.preempt('Unit 12');
  assert.strictEqual(signal.mainline, Phase.GREEN);
  assert.strictEqual(signal.cross, Phase.RED);
  for (let i = 0; i < 400; i++) signal.update(0.5);
  assert.strictEqual(signal.mainline, Phase.GREEN, 'a held light let go on its own');
  assert.strictEqual(signal.mainlineGreenLeft, Infinity);

  signal.release();
  assert.strictEqual(signal.mainline, Phase.GREEN, 'the cycle did not restart on the highway green');
  assert.ok(signal.mainlineGreenLeft > 1, 'the highway got a token green after the preemption');
});

test('every signalised junction on the route has a controller', () => {
  const network = new SignalNetwork(route);
  const signalled = route.junctions.filter((j) => j.signal);
  console.log(`  ${network.signals.length} signals over ${route.junctions.length} junctions`);
  assert.strictEqual(network.signals.length, signalled.length);
  assert.ok(signalled.length >= 4, 'a route through town with no lights on it');
  for (const j of signalled) {
    assert.ok(network.for(j), `${j.name} has no controller`);
    assert.ok(j.crossing, `${j.name} is signalised but has no road going the other way`);
  }
  const next = network.next(8000, 1);
  assert.ok(next && next.s > 8000, 'nothing found ahead');
  assert.strictEqual(network.next(8000, -1).s < 8000, true, 'looked the wrong way');
});
