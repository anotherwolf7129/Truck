import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';

/**
 * Which way does a positive steer input turn the rig?
 *
 * Measured as yaw rate, not as accumulated heading: at full lock this rig
 * circles in about seven metres, so over any useful interval the heading wraps
 * past 180 degrees and a start-vs-end comparison is meaningless.
 *
 * In this frame (+Z forward, +Y up, right-handed) a positive yaw rate about +Y
 * swings the nose from +Z toward +X, and +X projects to the LEFT of the screen.
 * So turning to the driver's right means a NEGATIVE yaw rate.
 */
const g = { sample: () => ({ height: 0, normal: new Vector3(0,1,0), grip: 1 }) };
const dt = 1/200;

function measure(input) {
  const rig = new Rig();
  rig.air.psi = 120; rig.air.parkingBrake = false;
  for (let i=0;i<1000;i++) rig.step(dt,g);
  let s = 0;
  while (rig.speedMph < 15 && s < 300) {
    rig.throttle = 1; rig.powertrain.autoShift(dt,0.512,rig.tractor.forwardSpeed); rig.step(dt,g); s += dt;
  }
  // Ramp the wheel on and sample yaw rate once it has settled.
  let yaw = 0, n = 0;
  for (let i=0;i<200*4;i++) {
    rig.steerInput = input; rig.throttle = 0.3;
    rig.powertrain.autoShift(dt,0.512,rig.tractor.forwardSpeed); rig.step(dt,g);
    if (i > 200*2) { yaw += rig.tractor.body.angularVelocity.y; n++; }
  }
  return { yaw: yaw/n, steerAngle: rig.steerAngle };
}

for (const [input, key] of [[1,'D (steer right)'], [-1,'A (steer left)']]) {
  const r = measure(input);
  const dir = r.yaw < 0 ? 'RIGHT' : 'LEFT';
  console.log(`${key.padEnd(18)} input=${String(input).padStart(2)}  roadWheel=${(r.steerAngle*57.3).toFixed(1).padStart(6)} deg  yawRate=${r.yaw.toFixed(3)} rad/s  =>  turns ${dir}`);
}
