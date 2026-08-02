import test from 'node:test';
import assert from 'node:assert';
import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { Route } from '../src/world/Route.js';

/**
 * Which way is right?
 *
 * Three.js is right-handed, so with +Y up and the rig facing +Z the driver's
 * right-hand side is -X and a right turn is a *negative* rotation about +Y.
 * Assuming otherwise mirrors the entire simulation: the right arrow key steers
 * left, the load drives up the oncoming lane, and every sign ends up on the
 * wrong shoulder. That has been shipped twice, so it gets a test.
 *
 * These assertions are deliberately written against observable behaviour --
 * where the rig ends up, which side of the paint the permitted lane is on --
 * rather than against the sign of any particular constant, so they still hold
 * whatever the internals are refactored into.
 */

const flatGround = {
  sample() { return { height: 0, normal: new Vector3(0, 1, 0), grip: 1 }; },
};

const LOCAL_FWD = new Vector3(0, 0, 1);
const WORLD_UP = new Vector3(0, 1, 0);

/** The driver's right, derived from first principles rather than an axis label. */
function trueRight(body, out = new Vector3()) {
  body.localToWorldDir(LOCAL_FWD, out).normalize();
  return out.cross(WORLD_UP).normalize();
}

function rollingRig(dt = 1 / 240, mph = 18) {
  const rig = new Rig();
  rig.air.psi = 120;
  rig.air.parkingBrake = false;
  for (let i = 0; i < 1200; i++) rig.step(dt, flatGround);
  rig.powertrain.gear = 6;
  while (rig.speedMph < mph) {
    rig.throttle = 1;
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, flatGround);
  }
  return rig;
}

/** Metres the rig moved to its own right over `seconds` of held steering. */
function driftUnderSteer(steerInput, seconds = 4, dt = 1 / 240) {
  const rig = rollingRig(dt);
  const body = rig.tractor.body;
  const right = trueRight(body);
  const start = body.position.clone();

  rig.steerInput = steerInput;
  for (let i = 0; i < seconds / dt; i++) {
    rig.throttle = 0.35;
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, flatGround);
  }
  return body.position.clone().sub(start).dot(right);
}

test('the right arrow steers right and the left arrow steers left', () => {
  const right = driftUnderSteer(1);
  const left = driftUnderSteer(-1);
  console.log(`  steer +1 -> ${right.toFixed(1)} m to the rig's right, ` +
    `steer -1 -> ${left.toFixed(1)} m`);
  assert.ok(right > 5, `steering right moved the rig ${right.toFixed(1)} m to its right`);
  assert.ok(left < -5, `steering left moved the rig ${left.toFixed(1)} m to its right`);
});

test('the rig holds a straight line with no steering input', () => {
  const drift = driftUnderSteer(0);
  console.log(`  no input -> ${drift.toFixed(2)} m of lateral drift in 4 s`);
  assert.ok(Math.abs(drift) < 1.5, `wandered ${drift.toFixed(2)} m with the wheel centred`);
});

test('the permitted lane is on the right-hand side of the road', () => {
  const route = new Route();
  for (const s of [40, 3400, 6400, 9500, 11400]) {
    const sample = route.at(s);
    // The right-hand side of the direction of travel, from the tangent alone.
    const right = sample.tangent.clone().cross(WORLD_UP).normalize();
    const centre = route.positionAt(s, 0, new Vector3());
    const lane = route.positionAt(s, route.convoyLaneOffset(s), new Vector3());
    const across = lane.sub(centre).dot(right);
    assert.ok(across > 1,
      `at s=${s} the permitted lane sits ${across.toFixed(2)} m right of the centreline`);

    const oncoming = route.positionAt(s, route.laneOffsetAt(s, -1, 0), new Vector3());
    assert.ok(oncoming.sub(centre).dot(right) < -1,
      `at s=${s} the oncoming lane is not on the far side of the paint`);
  }
});

test('the steerman winds the rear axles out of the corner, not into it', () => {
  const dt = 1 / 240;
  const rig = rollingRig(dt, 8);
  rig.steerInput = 0.55;
  for (let i = 0; i < 8 / dt; i++) {
    rig.throttle = 0.25;
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, flatGround);
  }
  const articulation = rig.yawB.angle;
  console.log(`  articulation ${(articulation * 57.3).toFixed(1)} deg, ` +
    `rear axles ${(rig.trailerSteerAngle * 57.3).toFixed(1)} deg`);
  assert.ok(Math.abs(articulation) > 0.15, 'the corner did not articulate the rig');
  assert.ok(Math.abs(rig.trailerSteerAngle) > 0.05, 'the steerman never took any lock');
  assert.ok(Math.sign(rig.trailerSteerAngle) === -Math.sign(articulation),
    'the rear axles are steering with the articulation instead of against it');
});

test('the steerman lets go above manoeuvring speed', () => {
  const dt = 1 / 240;
  const rig = rollingRig(dt, 30);
  rig.steerInput = 0.2;
  for (let i = 0; i < 4 / dt; i++) {
    rig.throttle = 0.5;
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, flatGround);
  }
  console.log(`  ${rig.speedMph.toFixed(0)} mph -> rear axles ` +
    `${(rig.trailerSteerAngle * 57.3).toFixed(2)} deg`);
  assert.ok(rig.speedMph > 25, `only reached ${rig.speedMph.toFixed(0)} mph`);
  assert.ok(Math.abs(rig.trailerSteerAngle) < 0.02,
    `rear axles still at ${(rig.trailerSteerAngle * 57.3).toFixed(1)} deg at road speed`);
});

test('the steerman box overrides the automatics', () => {
  const dt = 1 / 240;
  const rig = rollingRig(dt, 8);
  rig.steerInput = 0.55;
  rig.trailerSteerInput = 1;   // steerman calls the rear axles right
  for (let i = 0; i < 6 / dt; i++) {
    rig.throttle = 0.25;
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, flatGround);
  }
  assert.ok(rig.autoTrailerSteer, 'the automatics were meant to still be armed');
  // Right is a negative rotation about +Y, same as the tractor's steer axle.
  assert.ok(rig.trailerSteerAngle < -0.3,
    `manual input gave ${rig.trailerSteerAngle.toFixed(3)} rad, expected full right lock`);
});
