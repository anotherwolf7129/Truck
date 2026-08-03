/**
 * Does the steerman earn his place on the box?
 *
 * Off-tracking is how far inside the tractor's path the back of the trailer
 * runs through a corner. It is the number that decides whether a permit move
 * fits round a bend, and shortening it is the whole reason a lowboy's rear
 * axles steer at all.
 *
 * Measuring it honestly means waiting for the rig to settle into a steady
 * circle and then comparing radii about that circle's centre, rather than
 * comparing a point against a path -- on a closed loop the nearest point on the
 * path is not the one the trailer is cutting inside of.
 *
 * Three runs, same corner: rear axles locked straight, the steerman's
 * automatics, and a steerman winding it the wrong way.
 */
import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';

const ground = { sample: () => ({ height: 0, normal: new Vector3(0, 1, 0), grip: 1 }) };
const dt = 1 / 240;
const DEG = 180 / Math.PI;

/** Algebraic (Kasa) circle fit over XZ points. */
function fitCircle(points) {
  let sx = 0, sz = 0;
  for (const p of points) { sx += p.x; sz += p.z; }
  const mx = sx / points.length;
  const mz = sz / points.length;

  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of points) {
    const u = p.x - mx;
    const v = p.z - mz;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v;
    suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const c1 = (suuu + suvv) / 2;
  const c2 = (svvv + svuu) / 2;
  const uc = (c1 * svv - c2 * suv) / det;
  const vc = (c2 * suu - c1 * suv) / det;
  return new Vector3(uc + mx, 0, vc + mz);
}

const meanRadius = (points, centre) =>
  points.reduce((s, p) => s + Math.hypot(p.x - centre.x, p.z - centre.z), 0) / points.length;

function corner({ auto, manual = 0, mph = 8, steer = 0.55, seconds = 34 }) {
  const rig = new Rig();
  rig.air.psi = 120;
  rig.air.parkingBrake = false;
  rig.autoTrailerSteer = false;
  for (let i = 0; i < 1200; i++) rig.step(dt, ground);

  rig.powertrain.gear = 3;
  while (rig.speedMph < mph) {
    rig.throttle = 1;
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, ground);
  }

  rig.autoTrailerSteer = auto;
  rig.trailerSteerInput = manual;
  rig.steerInput = steer;

  // Three points: the steer axle, the gooseneck the steerman is nulling the
  // trailer against, and the trailer's rearmost axle.
  const rearWheel = rig.trailer.wheels
    .reduce((a, w) => (w.position.z < a.position.z ? w : a), rig.trailer.wheels[0]);
  const front = [];
  const neck = [];
  const rear = [];
  let rearAngle = 0;
  let articulation = 0;

  const steps = Math.floor(seconds / dt);
  const settle = Math.floor(steps * 0.45);   // let the corner reach steady state
  for (let i = 0; i < steps; i++) {
    const err = mph - rig.speedMph;
    rig.throttle = Math.max(0, Math.min(0.6, err * 0.3));
    rig.brake = Math.max(0, Math.min(0.4, -err * 0.15));
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, ground);
    if (i < settle) continue;

    front.push(rig.tractor.body.localToWorld(new Vector3(0, 0, rig.wheelbase * 0.5), new Vector3()));
    neck.push(rig.trailer.body.localToWorld(new Vector3(0, 0, rig.spec.couplingZ), new Vector3()));
    rear.push(rig.trailer.body.localToWorld(rearWheel.position.clone(), new Vector3()));
    rearAngle = Math.max(rearAngle, Math.abs(rig.trailerSteerAngle));
    articulation = Math.max(articulation, Math.abs(rig.yawB.angle));
  }

  const centre = fitCircle(front);
  if (!centre) return null;
  const rFront = meanRadius(front, centre);
  const rNeck = meanRadius(neck, centre);
  const rRear = meanRadius(rear, centre);
  return {
    swept: rFront - rRear,      // what the corner has to be wide enough for
    trailerOnly: rNeck - rRear, // the part the steerman can actually null
    rFront,
    rearAngle,
    articulation,
  };
}

const cases = [
  ['rear axles locked straight', { auto: false }],
  ['steerman on the automatics', { auto: true }],
  // Wound into the corner rather than out of it. Any rear steer shortens the
  // swept path a little, but this way round gives up most of the benefit and
  // winds the articulation further toward the jackknife stop while doing it.
  ['steerman winding it into the corner', { auto: false, manual: 1 }],
];

console.log('OFF-TRACK, steady 8 mph corner at 0.55 rad of steer:\n');
for (const [name, opts] of cases) {
  const r = corner(opts);
  console.log(
    `  ${name.padEnd(36)} ${r.swept.toFixed(2)} m swept path` +
    `   (${r.trailerOnly.toFixed(2)} m behind the gooseneck,` +
    ` rear axles to ${(r.rearAngle * DEG).toFixed(1)} deg,` +
    ` articulation ${(r.articulation * DEG).toFixed(1)} deg,` +
    ` turn radius ${r.rFront.toFixed(1)} m)`
  );
}
