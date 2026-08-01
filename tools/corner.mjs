import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
const g = { sample: () => ({ height: 0, normal: new Vector3(0,1,0), grip: 1 }) };
const dt = 1/240;
const r = new Rig();
r.air.psi=120; r.air.parkingBrake=false;
for(let i=0;i<1200;i++) r.step(dt,g);
let s=0;
while (r.speedMph < 30 && s < 300){ r.throttle=1; r.powertrain.autoShift(dt,0.512,r.tractor.forwardSpeed); r.step(dt,g); s+=dt; }
console.log(`at speed ${r.speedMph.toFixed(1)} mph, gear ${r.powertrain.gearLabel}`);
r.throttle=0.3;
for(let i=0;i<240*10;i++){
  r.steerInput=0.30;
  r.powertrain.autoShift(dt,0.512,r.tractor.forwardSpeed);
  r.step(dt,g);
  if(i%240===0){
    const sw=r.tractor.wheels.filter(w=>w.steerable);
    const yaw=Math.abs(r.tractor.body.angularVelocity.y);
    const rad=yaw>1e-3? r.tractor.body.velocity.length()/yaw : Infinity;
    console.log(`t=${(i/240).toFixed(0)}s mph=${r.speedMph.toFixed(1)} steerAng=${(r.steerAngle*57.3).toFixed(1)}deg `+
      `swLoad=${(sw.reduce((a,w)=>a+w.load,0)/1000).toFixed(0)}kN swSlip=${(sw[0].slipAngle*57.3).toFixed(1)}deg `+
      `swLat=${(sw.reduce((a,w)=>a+w.latForce,0)/1000).toFixed(0)}kN sat=${sw[0].saturation.toFixed(2)} `+
      `R=${rad.toFixed(0)}m artic=${(r.yawA.angle*57.3).toFixed(1)}deg roll=${(r.trailer.rollAngle*57.3).toFixed(1)}deg`);
  }
}
