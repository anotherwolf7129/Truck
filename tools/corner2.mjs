import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
const g = { sample: () => ({ height: 0, normal: new Vector3(0,1,0), grip: 1 }) };
const dt = 1/240;
function atSpeed(mph){
  const r = new Rig(); r.air.psi=120; r.air.parkingBrake=false;
  for(let i=0;i<1200;i++) r.step(dt,g);
  let s=0;
  while(r.speedMph<mph && s<400){ r.throttle=1; r.powertrain.autoShift(dt,0.512,r.tractor.forwardSpeed); r.step(dt,g); s+=dt; }
  return r;
}
console.log('STEADY CORNER at 25 mph, ramping steer input (index 1.0 = rollover):');
for (const si of [0.05,0.08,0.12,0.16,0.20,0.25]) {
  const r = atSpeed(25);
  let peakIdx=0, peakG=0, peakRoll=0, peakArt=0, minMph=99;
  for(let i=0;i<240*14;i++){
    r.steerInput = Math.min(si, si*i/(240*2));   // 2s ramp, not a yank
    r.throttle=0.35; r.powertrain.autoShift(dt,0.512,r.tractor.forwardSpeed);
    r.step(dt,g);
    if(i>240*3){
      peakIdx=Math.max(peakIdx,r.rolloverWarning);
      peakG=Math.max(peakG,Math.abs(r.lateralAcceleration())/9.81);
      peakRoll=Math.max(peakRoll,Math.abs(r.trailer.rollAngle));
      peakArt=Math.max(peakArt,Math.abs(r.yawA.angle));
      minMph=Math.min(minMph,r.speedMph);
    }
  }
  const yaw=Math.abs(r.tractor.body.angularVelocity.y);
  const rad=yaw>1e-3?r.tractor.body.velocity.length()/yaw:Infinity;
  console.log(`  steer ${(si*r.maxSteerAngle*57.3).toFixed(1).padStart(4)}deg -> R=${rad.toFixed(0).padStart(3)}m  ${peakG.toFixed(2)} lat-g  index ${peakIdx.toFixed(2)}  roll ${(peakRoll*57.3).toFixed(1)}deg  artic ${(peakArt*57.3).toFixed(0)}deg  speed held ${minMph.toFixed(0)}-${r.speedMph.toFixed(0)} mph`);
}
console.log('\nCOAST-DOWN from 30 mph (drivetrain in neutral, no brakes):');
{
  const r = atSpeed(30);
  r.throttle=0; r.powertrain.neutral=true;
  const p0=r.tractor.body.position.clone(); let t=0;
  while(r.speedMph>15 && t<200){ r.step(dt,g); t+=dt; }
  console.log(`  30->15 mph in ${t.toFixed(1)}s over ${(r.tractor.body.position.distanceTo(p0)*3.28).toFixed(0)} ft (rolling drag only)`);
}
