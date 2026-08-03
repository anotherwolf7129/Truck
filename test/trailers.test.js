import test from 'node:test';
import assert from 'node:assert';
import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { TRAILERS, getTrailer, resolveTrailer } from '../src/physics/Trailers.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';

/**
 * The yard.
 *
 * Every trailer in the catalogue has to be a thing that can actually be moved:
 * it has to stand on its own wheels, weigh what the permit says, fit under the
 * structures on the route it is being sent down, and get round the tightest
 * corner on that route without going over. None of that is guaranteed by the
 * spec being well-formed -- the geometry is derived, and derived geometry can be
 * derived wrong -- so each of them is built and driven here rather than only
 * read.
 */

const flatGround = {
  sample() { return { height: 0, normal: new Vector3(0, 1, 0), grip: 1 }; },
};

function settle(rig, seconds = 6, dt = 1 / 200) {
  for (let i = 0; i < seconds / dt; i++) rig.step(dt, flatGround);
}

test('every trailer in the catalogue stands on its own wheels', () => {
  for (const spec of TRAILERS) {
    const rig = new Rig({ trailer: spec.id });
    rig.air.psi = 120;
    settle(rig);

    const supported = rig.units.reduce((s, u) => s + u.axleLoad, 0);
    const weight = rig.units.reduce((s, u) => s + u.body.mass, 0) * 9.81;
    console.log(
      `  ${spec.id.padEnd(9)} ${Math.round(rig.grossWeightLb).toLocaleString().padStart(9)} lb  `
      + `${(rig.combinationLength * 3.28084).toFixed(0).padStart(3)} ft  `
      + `${(rig.loadHeight * 3.28084).toFixed(2)} ft high  `
      + `${rig.units.reduce((n, u) => n + u.wheels.length, 0)} wheels  `
      + `${(100 * supported / weight).toFixed(0)}% on the tires`
    );

    for (const u of rig.units) {
      assert.ok(Number.isFinite(u.body.position.y), `${spec.id}: ${u.name} position NaN`);
      assert.ok(u.body.velocity.length() < 1.0,
        `${spec.id}: ${u.name} still moving at ${u.body.velocity.length().toFixed(2)} m/s`);
      // Every wheel on the road, none of them buried in it or hanging above it.
      for (const w of u.wheels) {
        assert.ok(w.grounded, `${spec.id}: a wheel on the ${u.name} is off the ground at rest`);
      }
    }
    assert.ok(supported > weight * 0.9 && supported < weight * 1.1,
      `${spec.id}: the tires carry ${(100 * supported / weight).toFixed(0)}% of the gross weight`);
  }
});

test('the couplings line up where the geometry says they do', () => {
  // Each unit's resting position is derived from the coupling chain rather than
  // written down, so a spec cannot be declared with its kingpin a metre from the
  // fifth wheel that is supposed to be holding it.
  for (const spec of TRAILERS) {
    const rig = new Rig({ trailer: spec.id });
    settle(rig, 5);
    const a = new Vector3();
    const b = new Vector3();
    for (const pivot of rig.pivots) {
      pivot.ball.worldAnchors(a, b);
      assert.ok(a.distanceTo(b) < 0.05,
        `${spec.id}: a coupling is ${(a.distanceTo(b) * 1000).toFixed(0)} mm apart`);
    }
  }
});

test('the catalogue actually spans a range worth choosing between', () => {
  const rigs = TRAILERS.map((spec) => new Rig({ trailer: spec.id }));
  const by = (fn) => rigs.map(fn);
  const gross = by((r) => r.grossWeightLb);
  const length = by((r) => r.combinationLength);
  const axles = by((r) => r.trailer.wheels.length / r.spec.tracks.length / 2);

  console.log(
    `  ${Math.round(Math.min(...gross)).toLocaleString()}-${Math.round(Math.max(...gross)).toLocaleString()} lb, `
    + `${(Math.min(...length) * 3.28084).toFixed(0)}-${(Math.max(...length) * 3.28084).toFixed(0)} ft, `
    + `${Math.min(...axles)}-${Math.max(...axles)} trailer axles`
  );

  assert.ok(TRAILERS.length >= 5, 'a yard with fewer than five trailers in it');
  assert.ok(Math.max(...gross) > Math.min(...gross) * 4,
    'the heaviest load is not meaningfully heavier than the lightest');
  assert.ok(Math.max(...length) > Math.min(...length) * 3,
    'the longest combination is not meaningfully longer than the shortest');

  // The big one and the long one are different trailers -- that is the point of
  // having both. The dual-lane platform is the heavy one and is not especially
  // long; the blade transporter is the long one and weighs less than the
  // excavator on the step deck.
  const heaviest = rigs[gross.indexOf(Math.max(...gross))];
  const longest = rigs[length.indexOf(Math.max(...length))];
  assert.strictEqual(heaviest.spec.id, 'duallane');
  assert.strictEqual(longest.spec.id, 'blade');
  assert.ok(longest.grossWeightLb < heaviest.grossWeightLb * 0.3,
    'the longest trailer should not also be the heaviest');
  assert.ok(heaviest.powertrain.powerUnits > 1,
    'nothing is pushing the heaviest combination but one tractor');
});

test('a wide track is harder to tip over than a tall load', () => {
  // The rollover threshold is half the track over the height of the centre of
  // gravity, and it is the single number that decides how fast each of these can
  // be taken round a corner. A dual-lane platform is nearly three metres out to
  // each side, which is why the biggest load on the route is also the one least
  // likely to go over.
  const ssf = (id) => {
    const rig = new Rig({ trailer: id });
    return rig.trailerHalfTrack / rig.trailer.comHeight;
  };
  const lowboy = ssf('lowboy');
  const dual = ssf('duallane');
  console.log(`  static stability factor: lowboy ${lowboy.toFixed(2)}, dual-lane ${dual.toFixed(2)}`);
  assert.ok(dual > lowboy * 2, 'the dual-lane platform should be far harder to roll than the lowboy');
  assert.ok(lowboy > 0.35 && lowboy < 0.6, 'the lowboy has stopped being a tall load');
});

test('the steerman has a box on the trailers that have one, and none on the ones that do not', () => {
  const lowboy = new Rig({ trailer: 'lowboy' });
  const blade = new Rig({ trailer: 'blade' });
  const step = new Rig({ trailer: 'stepdeck' });

  // The long trailers steer further, because the geometry demands it: the rear
  // group is asked to hold minus the articulation angle, and a forty-seven metre
  // wheelbase articulates a long way.
  assert.ok(blade.maxTrailerSteer > lowboy.maxTrailerSteer,
    'the blade transporter should out-steer the lowboy');
  assert.strictEqual(step.maxTrailerSteer, 0, 'a step deck has no rear steer');
  assert.strictEqual(step.autoTrailerSteer, false, 'a steerman on a trailer with no steering box');
  assert.ok(step.trailer.wheels.every((w) => !w.tandemSteer));
  assert.ok(blade.trailer.wheels.some((w) => w.tandemSteer));
});

test('every load on the route fits under the tightest structure on it', () => {
  const route = new Route();
  const lowest = Math.min(...route.bridges.map((b) => b.clearance));
  for (const spec of TRAILERS) {
    const resolved = resolveTrailer(spec);
    const margin = lowest - resolved.loadHeight;
    console.log(`  ${spec.id.padEnd(9)} ${(margin * 100).toFixed(0)} cm under the ${lowest.toFixed(2)} m structure`);
    assert.ok(margin > 0,
      `${spec.id} cannot be permitted down this route: ${(margin * 100).toFixed(0)} cm`);
  }
  // And at least one of them is tight enough that the height pole matters.
  const tightest = Math.min(...TRAILERS.map((s) => lowest - resolveTrailer(s).loadHeight));
  assert.ok(tightest < 0.4, 'no load on the route comes close to anything overhead');
});

/**
 * The tightest corner on the route, driven by the same unremarkable autopilot
 * the mission test uses: hold the advisory speed, aim at the middle of the
 * permitted lane.
 *
 * This is the assertion that matters for a catalogue of trailers. A spec can be
 * internally consistent and still be undrivable -- a rear group that steers the
 * wrong way, or a wheelbase nothing can get round a sixty-metre radius with.
 */
function driveCorner(id, corner, route, ground) {
  const rig = new Rig({ trailer: id });
  const start = corner.s - 320;
  rig.placeAt(
    route.positionAt(start, route.convoyLaneOffset(start), new Vector3()),
    route.headingAt(start),
    ground
  );
  rig.air.psi = 120;
  rig.air.parkingBrake = false;
  for (let i = 0; i < 300; i++) rig.step(1 / 200, ground);

  const dt = 1 / 150;
  const proj = {};
  let peakRollover = 0;
  let worstOffPavement = -Infinity;
  let s = start;

  for (let i = 0; i < 150 * 260; i++) {
    const p = rig.tractor.body.position;
    route.project(p.x, p.z, proj);
    s = proj.s;
    if (s > corner.s + 300) break;

    let target = route.advisorySpeedAt(s);
    const lookahead = Math.min(260, 60 + Math.abs(rig.speedMph) * 6);
    for (let d = 20; d <= lookahead; d += 40) {
      target = Math.min(target, route.advisorySpeedAt(s + d) + 4);
    }
    const err = target - rig.speedMph;
    rig.throttle = Math.max(0, Math.min(1, err * 0.22));
    rig.brake = Math.max(0, Math.min(0.75, -err * 0.10));

    const aimS = s + Math.max(18, Math.abs(rig.speedMph) * 1.5);
    const aim = route.positionAt(aimS, route.convoyLaneOffset(aimS), new Vector3());
    const fwd = rig.tractor.body.localToWorldDir(new Vector3(0, 0, 1), new Vector3());
    const right = rig.tractor.body.localToWorldDir(new Vector3(-1, 0, 0), new Vector3());
    const toAim = aim.sub(p);
    rig.steerInput = Math.max(-1, Math.min(1,
      Math.atan2(toAim.dot(right), Math.max(1, toAim.dot(fwd))) * 2.2));

    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, ground);

    peakRollover = Math.max(peakRollover, rig.telemetry.rollover);
    for (const u of rig.units) {
      const q = route.project(u.body.position.x, u.body.position.z, {});
      worstOffPavement = Math.max(worstOffPavement, Math.abs(q.lateral) - route.halfWidthAt(q.s));
    }
  }
  return { peakRollover, worstOffPavement, reached: s };
}

test('every trailer gets round the tightest corner on the route', () => {
  const route = new Route();
  const ground = new Ground(route);
  const corner = route.tightCorners.reduce((a, b) => (a.radius < b.radius ? a : b));

  for (const spec of TRAILERS) {
    const run = driveCorner(spec.id, corner, route, ground);
    console.log(
      `  ${spec.id.padEnd(9)} peak rollover ${run.peakRollover.toFixed(2)}, `
      + `worst unit ${run.worstOffPavement > 0 ? '+' : ''}${run.worstOffPavement.toFixed(1)} m `
      + `outside the pavement edge`
    );
    assert.ok(run.reached > corner.s,
      `${spec.id} never made it round ${corner.name}`);
    assert.ok(run.peakRollover < 0.9,
      `${spec.id} came within ${(run.peakRollover * 100).toFixed(0)}% of rolling on ${corner.name}`);
    // A unit's centre may reach the edge of the pavement -- these corners are
    // taken using all of it -- but nothing should be out in the verge.
    assert.ok(run.worstOffPavement < 2.0,
      `${spec.id} put a unit ${run.worstOffPavement.toFixed(1)} m off the pavement on ${corner.name}`);
  }
});

test('an unknown trailer id falls back to the default rather than throwing', () => {
  assert.strictEqual(getTrailer('no such thing').id, 'lowboy');
  assert.strictEqual(getTrailer(undefined).id, 'lowboy');
  // A cargo override still works on a known trailer, which is how a different
  // load goes on a trailer that already exists.
  const rig = new Rig({ trailer: 'lowboy', cargo: { mass: 20000, name: 'Ballast' } });
  assert.strictEqual(rig.cargo.name, 'Ballast');
  assert.strictEqual(rig.cargo.mass, 20000);
  assert.ok(rig.grossWeightLb < new Rig({ trailer: 'lowboy' }).grossWeightLb);
});
