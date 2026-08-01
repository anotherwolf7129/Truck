import test from 'node:test';
import assert from 'node:assert';
import { Route } from '../src/world/Route.js';
import { ConvoyManager, Role } from '../src/ai/Escort.js';
import { TrafficManager } from '../src/ai/Traffic.js';

const LOAD = { lateral: 0, halfWidth: 1.83, length: 27 };

/**
 * Traffic spawning is random, and a test that only sometimes drives a car past
 * the load is not a regression test. Runs get a fixed stream instead.
 */
function seedRandom(seed) {
  const original = Math.random;
  let x = seed >>> 0;
  Math.random = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
  return () => { Math.random = original; };
}

/**
 * Runs the escorts and the ambient traffic against a load moving down the route
 * at the advisory speed.
 *
 * The rig itself is not simulated here: what is under test is whether the other
 * vehicles on the road behave like vehicles -- steering into their lane changes,
 * staying out of the load, and queueing behind the rear escort instead of
 * streaming past a 3.66 m wide transformer.
 */
function runConvoy({ minutes = 12, stopAt = null, seed = 20260801 } = {}) {
  const restoreRandom = seedRandom(seed);
  const route = new Route();
  const convoy = new ConvoyManager(route, null);
  const traffic = new TrafficManager(route, { density: 1 });

  LOAD.lateral = route.laneWidth * 0.5;

  let s = 30;
  let speed = 0;
  convoy.reset(s);

  const dt = 1 / 60;
  const steps = Math.floor((minutes * 60) / dt);

  const report = {
    trafficInsideLoad: 0,
    escortInsideLoad: 0,
    trafficInsideEscort: 0,
    passedTheRearEscort: 0,
    maxYaw: 0,
    maxSteer: 0,
    maxSpin: 0,
    queuedFrames: 0,
    nonFinite: 0,
  };

  const overlapsLoad = (at, halfLen, lateral, halfWidth) =>
    at + halfLen > s - LOAD.length - 0.5 && at - halfLen < s + 0.5
    && Math.abs(lateral - LOAD.lateral) < halfWidth + LOAD.halfWidth;

  for (let i = 0; i < steps; i++) {
    // Hold the advisory speed, and optionally stop dead at a point on the route
    // so the escorts and the queue behind have to deal with a load that is no
    // longer moving.
    const halted = stopAt !== null && s > stopAt;
    const advisory = halted ? 0 : route.advisorySpeedAt(s) / 2.23694;
    speed += Math.max(-1.6 * dt, Math.min(0.5 * dt, advisory - speed));
    speed = Math.max(0, speed);
    s += speed * dt;
    if (s > route.length - 40) break;

    convoy.traffic = traffic.vehicles;
    convoy.update(dt, s, speed, 4.95, LOAD);
    traffic.update(dt, {
      convoy: { s, speed, ...LOAD },
      escorts: convoy.vehicles,
      blockades: convoy.blockades,
      route,
    });

    const rearPilot = convoy.vehicles.find((v) => v.role === Role.REAR_PILOT);

    for (const unit of convoy.vehicles) {
      if (overlapsLoad(unit.s, unit.length * 0.5, unit.lateral, unit.width * 0.5)) {
        report.escortInsideLoad++;
      }
      if (!Number.isFinite(unit.position.x) || !Number.isFinite(unit.heading)) report.nonFinite++;
    }

    for (const v of traffic.vehicles) {
      if (overlapsLoad(v.s, v.length * 0.5, v.currentOffset, v.width * 0.5)) {
        report.trafficInsideLoad++;
      }
      for (const unit of convoy.vehicles) {
        const near = Math.abs(v.s - unit.s) < (v.length + unit.length) * 0.5;
        const side = Math.abs(v.currentOffset - unit.lateral) < (v.width + unit.width) * 0.5;
        if (near && side) report.trafficInsideEscort++;
      }
      // Nothing in the convoy's own direction gets past the escort behind it.
      if (v.direction > 0 && v.s > rearPilot.s + 2) report.passedTheRearEscort++;
      if (v.state === 'queued') report.queuedFrames++;

      const road = v.pose.roadHeading(v.s);
      report.maxYaw = Math.max(report.maxYaw, Math.abs(v.heading - road));
      report.maxSteer = Math.max(report.maxSteer, Math.abs(v.pose.steerAngle));
      report.maxSpin = Math.max(report.maxSpin, Math.abs(v.pose.wheelSpin));
      if (!Number.isFinite(v.position.x) || !Number.isFinite(v.heading)) report.nonFinite++;
    }
  }

  restoreRandom();
  report.distanceMi = s / 1609.34;
  return report;
}

let moving;
test('nothing on the road drives through the load', () => {
  moving = runConvoy();
  console.log(
    `  ${moving.distanceMi.toFixed(2)} mi: ${moving.trafficInsideLoad} traffic overlaps, ` +
    `${moving.escortInsideLoad} escort overlaps, ${moving.trafficInsideEscort} escort/traffic overlaps`
  );
  assert.strictEqual(moving.trafficInsideLoad, 0, 'ambient traffic occupied the same road as the load');
  assert.strictEqual(moving.escortInsideLoad, 0, 'an escort drove through the load');
  assert.strictEqual(moving.trafficInsideEscort, 0, 'ambient traffic drove through an escort');
  assert.strictEqual(moving.nonFinite, 0);
});

test('traffic queues behind the rear escort instead of passing the load', () => {
  console.log(`  ${moving.queuedFrames} vehicle-frames queued behind the convoy`);
  assert.strictEqual(moving.passedTheRearEscort, 0, 'traffic got past the escort behind the load');
  assert.ok(moving.queuedFrames > 0, 'no traffic ever caught up with the convoy to queue behind it');
});

test('vehicles steer into their lane changes rather than sliding sideways', () => {
  // Oncoming traffic taking the shoulder for the load is a 4 m lateral move. If
  // the body never yaws and the wheels never turn, it reads as a box on rails.
  console.log(
    `  peak yaw off the centreline ${(moving.maxYaw * 57.3).toFixed(1)} deg, ` +
    `peak steer ${(moving.maxSteer * 57.3).toFixed(1)} deg`
  );
  assert.ok(moving.maxYaw > 0.02, 'no vehicle ever yawed away from the road heading');
  assert.ok(moving.maxYaw < 0.9, `yaw angle is unphysical (${moving.maxYaw.toFixed(2)} rad)`);
  assert.ok(moving.maxSteer > 0.02, 'front wheels never turned');
  assert.ok(moving.maxSpin > 100, 'wheels never rolled');
});

test('a load that stops still is not run into from behind', () => {
  // The station keeper is a speed controller, and a speed controller will drive
  // straight through a stationary load unless something stops it.
  const halted = runConvoy({ minutes: 10, stopAt: 2500, seed: 4242 });
  console.log(
    `  stopped at 2500 m: ${halted.escortInsideLoad} escort overlaps, ` +
    `${halted.trafficInsideLoad} traffic overlaps`
  );
  assert.strictEqual(halted.escortInsideLoad, 0);
  assert.strictEqual(halted.trafficInsideLoad, 0);
  assert.strictEqual(halted.passedTheRearEscort, 0);
});
