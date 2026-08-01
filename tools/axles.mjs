import { Rig } from '../src/physics/Rig.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';
import { Vector3 } from 'three';

const route = new Route();
const ground = new Ground(route);
const rig = new Rig({ cargo: { name:'t', mass:68000, size:new Vector3(3.66,3.60,8.40), centerHeight:2.35 }});
const dt = 1/200;
const startS = 7200;
rig.placeAt(route.positionAt(startS, route.laneWidth*0.5, new Vector3()), route.headingAt(startS), ground);
rig.air.psi = 120; rig.air.parkingBrake = false;

for (let i=0;i<1400;i++) rig.step(dt, ground);      // settle on the real road
const weightLb = rig.grossWeightLb;

function sample(seconds, drive) {
  let sum=0, n=0, min=1e9, max=0;
  for (let i=0;i<seconds/dt;i++){
    drive(rig);
    rig.powertrain.autoShift(dt, 0.512, rig.tractor.forwardSpeed);
    rig.step(dt, ground);
    const lb = rig.axleWeights().reduce((a,g)=>a+g.lb,0);
    sum+=lb; n++; min=Math.min(min,lb); max=Math.max(max,lb);
  }
  return {mean:sum/n, min, max};
}

console.log(`gross = ${Math.round(weightLb).toLocaleString()} lb\n`);
let r = sample(6, (x)=>{x.throttle=0;x.brake=0;});
console.log(`parked : mean ${Math.round(r.mean).toLocaleString()} (${(r.mean/weightLb*100).toFixed(0)}%)  range ${Math.round(r.min).toLocaleString()}-${Math.round(r.max).toLocaleString()}`);

for (let i=0;i<3000;i++){ rig.throttle=1; rig.powertrain.autoShift(dt,0.512,rig.tractor.forwardSpeed); rig.step(dt,ground); }
console.log(`(accelerated to ${rig.speedMph.toFixed(0)} mph)`);
r = sample(12, (x)=>{x.throttle=0.4;x.brake=0;});
console.log(`rolling: mean ${Math.round(r.mean).toLocaleString()} (${(r.mean/weightLb*100).toFixed(0)}%)  range ${Math.round(r.min).toLocaleString()}-${Math.round(r.max).toLocaleString()}`);

console.log('\nper-group means while rolling:');
const acc = {}; let n=0;
for (let i=0;i<12/dt;i++){
  rig.throttle=0.4; rig.powertrain.autoShift(dt,0.512,rig.tractor.forwardSpeed); rig.step(dt,ground);
  for (const g of rig.axleWeights()) acc[g.label]=(acc[g.label]||0)+g.lb;
  n++;
}
for (const [k,v] of Object.entries(acc)) console.log(`  ${k.padEnd(8)} ${Math.round(v/n).toLocaleString()} lb`);
