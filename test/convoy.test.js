import test from 'node:test';
import assert from 'node:assert';
import { Vector3 } from 'three';
import { Route } from '../src/world/Route.js';
import { ConvoyManager } from '../src/ai/Escort.js';
import { TrafficManager, approachAngle } from '../src/ai/Traffic.js';

/**
 * Escorts and ambient traffic, driven along the route against a convoy moving at
 * a realistic pace. These check the things that are obvious on screen and
 * invisible to a physics test: whether anything drives through the load, whether
 * following traffic overtakes it, and whether vehicles point where they are
 * going instead of sliding sideways.
 */
function simulate({ minutes = 14, convoySpeedMph = 22, length = 26 } = {}) {
  const route = new Route();
  const rig = { combinationLength: length };
  const convoy = new ConvoyManager(route, rig);
  const traffic = new TrafficManager(route, { density: 1 });

  let s = route.staging.s;
  const speed = convoySpeedMph / 2.23694;
  convoy.reset(s);

  const dt = 1 / 30;
  const steps = Math.floor((minutes * 60) / dt);

  // The load's own footprint in route coordinates: it sits in the right-hand
  // lane and is wider than that lane.
  const loadLateral = route.laneWidth * 0.5;
  const loadHalfWidth = 1.83;

  const worst = {
    escortOverlap: 0,      // metres of interpenetration with the load
    escortWhere: '',
    overtakenByTraffic: 0, // how far past the tail a following car ever got
    maxYawJump: 0,         // biggest single-frame heading change, radians
    maxCrabTraffic: 0,     // biggest angle between heading and motion, traffic
    maxCrabEscort: 0,      // ditto for escorts
    queued: 0,
  };
  const lastHeading = new Map();
  const lastPos = new Map();

  for (let i = 0; i < steps; i++) {
    s += speed * dt;
    if (s > route.length - 60) break;

    convoy.update(dt, s, speed, 4.15);
    traffic.update(dt, {
      convoy: { s, speed, length },
      chaseS: convoy.rearGuardS,
      blockades: convoy.blockades,
      route,
    });

    const tail = s - length;

    // --- Does any escort share space with the load? ------------------------
    for (const unit of convoy.vehicles) {
      if (unit.state === 'blocking') continue;      // parked off on a side road
      const alongside = unit.s > tail - unit.length && unit.s < s + unit.length;
      if (!alongside) continue;
      const clearance = Math.abs(unit.lateral - loadLateral) - (loadHalfWidth + unit.width / 2);
      if (-clearance > worst.escortOverlap) {
        worst.escortOverlap = -clearance;
        worst.escortWhere = `${convoy.unitName(unit)} (${unit.state})`;
      }
    }

    // --- Does following traffic get past the load? -------------------------
    for (const v of traffic.vehicles) {
      if (v.direction < 0) continue;
      if (v.state === 'following-convoy') worst.queued++;
      // A same-direction car that ends up ahead of the tail has overtaken it.
      const past = v.s - tail;
      if (past > worst.overtakenByTraffic && v.s < s + 400) worst.overtakenByTraffic = past;
    }

    // --- Do vehicles point where they are going? ---------------------------
    const all = [...traffic.vehicles, ...convoy.vehicles];
    for (const v of all) {
      const key = v.id ?? v.role;
      const prevH = lastHeading.get(key);
      if (prevH !== undefined) {
        let d = v.heading - prevH;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        worst.maxYawJump = Math.max(worst.maxYawJump, Math.abs(d));
      }
      lastHeading.set(key, v.heading);

      const prevP = lastPos.get(key);
      if (prevP) {
        const dx = v.position.x - prevP.x;
        const dz = v.position.z - prevP.z;
        const moved = Math.hypot(dx, dz);
        // Only meaningful while the vehicle is actually travelling. Below about
        // walking pace any car repositions itself sideways -- that is parking,
        // not sliding -- and a unit leaving a blockade is legitimately swinging
        // its nose back from sitting across the side road.
        const travelling = Math.abs(v.speed) > 4 && v.state !== 'blocking';
        if (moved > 0.25 && travelling) {
          const motion = Math.atan2(dx, dz);
          let crab = motion - v.heading;
          while (crab > Math.PI) crab -= Math.PI * 2;
          while (crab < -Math.PI) crab += Math.PI * 2;
          if (v.role !== undefined) worst.maxCrabEscort = Math.max(worst.maxCrabEscort, Math.abs(crab));
          else worst.maxCrabTraffic = Math.max(worst.maxCrabTraffic, Math.abs(crab));
        }
        prevP.set(v.position.x, v.position.y, v.position.z);
      } else {
        lastPos.set(key, v.position.clone());
      }
    }
  }
  return worst;
}

let result;
test('nothing drives through the load', () => {
  result = simulate();
  const cm = result.escortOverlap * 100;
  console.log(`  worst escort overlap with the load: ${cm.toFixed(0)} cm ${result.escortWhere}`);
  assert.ok(result.escortOverlap <= 0.01,
    `${result.escortWhere} passed through the load by ${cm.toFixed(0)} cm`);
});

test('following traffic never overtakes the load', () => {
  console.log(`  furthest a following car got past the tail: ${result.overtakenByTraffic.toFixed(1)} m`);
  console.log(`  vehicle-frames spent queued behind the convoy: ${result.queued}`);
  // Zero would mean the queue is not forming at all; a few metres of overlap
  // with the tail band is just the chase car's own following distance.
  assert.ok(result.queued > 500, 'no traffic ever queued behind the convoy');
  assert.ok(result.overtakenByTraffic < 12,
    `a car got ${result.overtakenByTraffic.toFixed(1)} m past the tail of the load`);
});

test('vehicles point where they are actually going', () => {
  console.log(`  worst crab: traffic ${(result.maxCrabTraffic * 57.3).toFixed(1)} deg, ` +
    `escorts ${(result.maxCrabEscort * 57.3).toFixed(1)} deg`);
  console.log(`  biggest single-frame yaw jump: ${(result.maxYawJump * 57.3).toFixed(1)} deg`);
  // A car sliding sideways with its nose still pointing down the road shows up
  // as a large angle between heading and direction of travel. Anything past
  // about 15 degrees is visibly crabbing rather than steering.
  assert.ok(result.maxCrabTraffic < 0.26,
    `traffic is crabbing ${(result.maxCrabTraffic * 57.3).toFixed(0)} deg -- sliding, not steering`);
  assert.ok(result.maxCrabEscort < 0.26,
    `escorts are crabbing ${(result.maxCrabEscort * 57.3).toFixed(0)} deg -- sliding, not steering`);
  assert.ok(result.maxYawJump < 0.35,
    `heading snapped ${(result.maxYawJump * 57.3).toFixed(0)} deg in one frame`);
});

test('approachAngle takes the short way around', () => {
  const near = approachAngle(3.0, -3.0, 1);
  // 3.0 to -3.0 is 0.28 rad the short way, not 6 rad the long way.
  assert.ok(near > 3.0, `went the long way: ${near.toFixed(2)}`);
  assert.strictEqual(approachAngle(0, 1, 0.25), 0.25);
  assert.strictEqual(approachAngle(0, -1, 0.25), -0.25);
});
