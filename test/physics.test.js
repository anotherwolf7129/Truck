import test from 'node:test';
import assert from 'node:assert';
import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';

const flatGround = {
  sample() { return { height: 0, normal: new Vector3(0, 1, 0), grip: 1 }; },
};

function settle(rig, seconds, dt = 1 / 200) {
  for (let i = 0; i < seconds / dt; i++) rig.step(dt, flatGround);
}

test('rig settles onto its suspension without exploding', () => {
  const rig = new Rig();
  rig.air.psi = 120;
  settle(rig, 4);
  for (const u of rig.units) {
    assert.ok(Number.isFinite(u.body.position.y), `${u.name} position NaN`);
    assert.ok(u.body.position.y > 0.2 && u.body.position.y < 4,
      `${u.name} settled at y=${u.body.position.y.toFixed(2)}`);
    assert.ok(u.body.velocity.length() < 1.0,
      `${u.name} still moving at ${u.body.velocity.length().toFixed(2)} m/s`);
  }
});

test('supports its own gross weight on the tires', () => {
  const rig = new Rig();
  settle(rig, 5);
  const totalN = rig.units.reduce((s,u)=>s+u.axleLoad,0);
  const weightN = rig.units.reduce((s,u)=>s+u.body.mass,0) * 9.81;
  const ratio = totalN / weightN;
  console.log(`  supported ${(totalN/1000).toFixed(0)} kN vs weight ${(weightN/1000).toFixed(0)} kN (${(ratio*100).toFixed(1)}%)`);
  assert.ok(ratio > 0.85 && ratio < 1.15, `load ratio ${ratio.toFixed(3)}`);
});

test('gross weight is a realistic superload', () => {
  const rig = new Rig();
  console.log(`  gross ${Math.round(rig.grossWeightLb).toLocaleString()} lb`);
  assert.ok(rig.grossWeightLb > 150000 && rig.grossWeightLb < 300000);
});

test('hitches hold the units together', () => {
  const rig = new Rig();
  settle(rig, 5);
  const a = new Vector3(), b = new Vector3();
  rig.hitchA.worldAnchors(a, b);
  const errA = a.distanceTo(b);
  rig.hitchB.worldAnchors(a, b);
  const errB = a.distanceTo(b);
  console.log(`  hitch error A=${(errA*1000).toFixed(1)}mm B=${(errB*1000).toFixed(1)}mm`);
  assert.ok(errA < 0.05, `fifth wheel separated by ${errA}`);
  assert.ok(errB < 0.05, `gooseneck separated by ${errB}`);
});

// --- Behavioural checks --------------------------------------------------
// These pin the numbers that make the rig feel like 212,000 lb rather than a
// pickup truck. They are deliberately loose ranges, not exact values.

function drive(rig, seconds, fn, dt = 1 / 240) {
  for (let i = 0; i < seconds / dt; i++) {
    fn(rig, i * dt);
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, flatGround);
  }
}

function ready() {
  const rig = new Rig();
  rig.air.psi = 120;
  rig.air.parkingBrake = false;
  settle(rig, 5, 1 / 240);
  return rig;
}

test('accelerates like a superload, not a car', () => {
  const rig = ready();
  let t30 = null;
  drive(rig, 60, (r, t) => { r.throttle = 1; if (t30 === null && r.speedMph >= 30) t30 = t; });
  console.log(`  0-30 mph in ${t30 === null ? 'never' : t30.toFixed(1) + 's'}`);
  assert.ok(t30 !== null, 'never reached 30 mph');
  assert.ok(t30 > 15 && t30 < 60, `0-30 took ${t30.toFixed(1)}s`);
});

test('needs a realistic distance to stop', () => {
  const rig = ready();
  drive(rig, 45, (r) => { r.throttle = 1; });
  const v0 = rig.speedMph;
  const p0 = rig.tractor.body.position.clone();
  let t = 0;
  const dt = 1 / 240;
  while (rig.speedMph > 1 && t < 60) {
    rig.throttle = 0; rig.brake = 1;
    rig.step(dt, flatGround); t += dt;
  }
  const ft = rig.tractor.body.position.distanceTo(p0) * 3.28084;
  const gForce = (v0 / 2.23694) / t / 9.81;
  console.log(`  ${v0.toFixed(0)} mph -> stop in ${ft.toFixed(0)} ft (${gForce.toFixed(2)} g)`);
  // A loaded combination is brake-limited well below what the tires could do.
  assert.ok(gForce > 0.18 && gForce < 0.40, `deceleration ${gForce.toFixed(2)} g is not truck-like`);
});

test('rollover risk rises with corner severity and stays ordered', () => {
  const results = [];
  for (const steer of [0.06, 0.12, 0.20]) {
    const rig = ready();
    drive(rig, 30, (r) => { r.throttle = 1; });
    let peak = 0;
    drive(rig, 12, (r, t) => {
      r.throttle = 0.35;
      r.steerInput = Math.min(steer, steer * t / 2);
      if (t > 3) peak = Math.max(peak, r.rolloverWarning);
    });
    results.push(peak);
  }
  console.log(`  rollover index by steer angle: ${results.map((r) => r.toFixed(2)).join(' < ')}`);
  assert.ok(results[0] < results[1] && results[1] < results[2],
    `not monotonic: ${results.join(', ')}`);
});

test('trailer off-tracks inside the tractor through a corner', () => {
  const rig = ready();
  drive(rig, 25, (r) => { r.throttle = 1; });
  drive(rig, 10, (r, t) => { r.throttle = 0.3; r.steerInput = Math.min(0.25, 0.25 * t / 2); });
  // In a steady turn the trailer's path radius is smaller than the tractor's.
  const artic = Math.abs(rig.yawA.angle);
  console.log(`  articulation ${(artic * 57.3).toFixed(1)} deg`);
  assert.ok(artic > 0.02, 'trailer never articulated');
  assert.ok(artic < rig.yawA.limit, 'trailer jackknifed in a normal corner');
});

test('brakes fade when they are cooked', async () => {
  const { BrakeGroup } = await import('../src/physics/Brakes.js');
  const b = new BrakeGroup();
  b.update(1 / 60, 1, 120, 10);
  const cold = b.fade;
  b.tempC = 480;
  b.update(1 / 60, 1, 120, 10);
  console.log(`  fade at 480 C: ${(b.fade * 100).toFixed(0)}% of cold torque`);
  assert.strictEqual(cold, 1);
  assert.ok(b.fade < 0.5, `no meaningful fade: ${b.fade}`);
});

test('spring brakes drop when air pressure is lost', () => {
  const rig = ready();
  rig.air.psi = 20;
  rig.step(1 / 240, flatGround);
  const applied = rig.tractor.wheels[0].brake.applied;
  console.log(`  at 20 psi, brake application = ${applied.toFixed(2)}`);
  assert.ok(applied > 0.9, 'spring brakes did not apply on air loss');
});
