import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
const g = { sample: () => ({ height: 0, normal: new Vector3(0,1,0), grip: 1 }) };
const dt = 1/240;
const MPH = 2.23694, FT = 3.28084;

function make() {
  const rig = new Rig();
  rig.air.psi = 120; rig.air.parkingBrake = false;
  for (let i=0;i<1200;i++) rig.step(dt, g);   // settle
  return rig;
}

// --- Acceleration, with realistic manual shifting -------------------------
const rig = make();
rig.powertrain.gear = 0;
let t = 0, log = [];
const marks = [5,10,15,20,25,30,35,40];
let mi = 0;
while (t < 240 && mi < marks.length) {
  rig.throttle = 1; rig.brake = 0;
  // shift up near governed speed, down if lugging
  rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
  rig.step(dt, g); t += dt;
  const mph = rig.speedMph;
  while (mi < marks.length && mph >= marks[mi]) {
    log.push(`  0-${marks[mi]} mph: ${t.toFixed(1)}s  (gear ${rig.powertrain.gearLabel}, ${Math.round(rig.powertrain.rpm)} rpm)`);
    mi++;
  }
}
console.log('ACCELERATION (212,746 lb, full throttle):');
console.log(log.join('\n'));
console.log(`  top speed reached: ${rig.speedMph.toFixed(1)} mph in ${t.toFixed(0)}s\n`);

// --- Braking distance from 30 mph ----------------------------------------
for (const useJake of [false, true]) {
  const r = make();
  r.powertrain.gear = 11;
  let s = 0;
  while (r.speedMph < 30 && s < 300) { r.throttle=1;
    r.powertrain.autoShift(dt, 0.512, r.tractor.forwardSpeed); r.step(dt,g); s+=dt; }
  const v0 = r.speedMph;
  const p0 = r.tractor.body.position.clone();
  r.throttle = 0; r.brake = 1; r.powertrain.engineBrakeStage = useJake ? 3 : 0;
  let bt = 0;
  while (r.speedMph > 1 && bt < 60) { r.step(dt,g); bt += dt; }
  const dist = r.tractor.body.position.distanceTo(p0);
  const decel = (v0/MPH) / bt;
  console.log(`BRAKING from ${v0.toFixed(1)} mph${useJake?' + engine brake':''}: ${(dist*FT).toFixed(0)} ft in ${bt.toFixed(1)}s  (${(decel/9.81).toFixed(2)} g)`);
  console.log(`  peak brake temp ${Math.round(Math.max(...r.units.flatMap(u=>u.wheels.map(w=>w.brake.tempC))))} C, air ${r.air.psi.toFixed(0)} psi`);
}

// --- Steady corner: how fast before the load wants to roll ---------------
console.log('\nCORNERING (rollover margin, 1.0 = tipping):');
for (const mph of [15, 20, 25, 30, 35]) {
  const r = make();
  r.powertrain.gear = 10;
  let s=0;
  while (r.speedMph < mph && s < 300) { r.throttle=1;
    r.powertrain.autoShift(dt, 0.512, r.tractor.forwardSpeed); r.step(dt,g); s+=dt; }
  r.throttle = 0.25;
  r.powertrain.autoShift(dt, 0.512, r.tractor.forwardSpeed);
  let peak = 0, roll = 0;
  for (let i=0;i<240*12;i++) {
    r.steerInput = 0.30;             // steady ~11 deg of wheel
    r.step(dt,g);
    peak = Math.max(peak, r.rolloverWarning);
    roll = Math.max(roll, Math.abs(r.trailer.rollAngle));
  }
  const lifted = r.trailer.wheels.filter(w=>!w.grounded).length;
  const latG = Math.abs(r.lateralAcceleration())/9.81;
  const yawR = Math.abs(r.tractor.body.angularVelocity.y);
  const radius = yawR > 1e-3 ? r.tractor.body.velocity.length()/yawR : Infinity;
  console.log(`  ${String(mph).padStart(2)} mph -> index ${peak.toFixed(2)}, ${latG.toFixed(2)} lat-g, roll ${(roll*57.3).toFixed(1)} deg, radius ${radius.toFixed(0)}m, ${lifted}/8 wheels lifted`);
}
