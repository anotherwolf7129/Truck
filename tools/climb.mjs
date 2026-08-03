import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';

const route=new Route(), ground=new Ground(route);
const rig=new Rig({trailer: process.argv[3] ?? 'lowboy'});
// The steepest sustained climb on the route: Prospect Hill, out of downtown.
const s0=Number(process.argv[2] ?? 4820);
rig.placeAt(route.positionAt(s0, route.convoyLaneOffset(s0), new Vector3()), route.headingAt(s0), ground);
rig.air.psi=120; rig.air.parkingBrake=false;
const dt=1/200;
// start at 10 mph in a low gear
const v=10/2.23694;
const dir=new Vector3(Math.sin(route.headingAt(s0)),0,Math.cos(route.headingAt(s0)));
for(const u of rig.units){u.body.velocity.copy(dir).multiplyScalar(v); for(const w of u.wheels) w.spin=v/w.radius;}
rig.powertrain.gear=2;
for(let i=0;i<400;i++){rig.throttle=1;rig.step(dt,ground);}

console.log(`grade at s=${s0}: ${(route.gradeAt(s0)*100).toFixed(1)}%`);
const mass = rig.units.reduce((a,u)=>a+u.body.mass,0);
console.log(`mass ${mass} kg -> grade force needed ${(mass*9.81*route.gradeAt(s0)/1000).toFixed(0)} kN\n`);
for(let i=0;i<200*40;i++){
  rig.throttle=1; rig.brake=0;
  // hold the lane
  {
    const p=rig.tractor.body.position; const pr=route.project(p.x,p.z);
    const aim=route.positionAt(pr.s+Math.max(18,Math.abs(rig.speedMph)*1.5), route.convoyLaneOffset(pr.s), new Vector3());
    const fwd=rig.tractor.body.localToWorldDir(new Vector3(0,0,1),new Vector3());
    const right=rig.tractor.body.localToWorldDir(new Vector3(-1,0,0),new Vector3());
    const toAim=aim.sub(p);
    rig.steerInput=Math.max(-1,Math.min(1,Math.atan2(toAim.dot(right),Math.max(1,toAim.dot(fwd)))*2.2));
  }
  rig.powertrain.autoShift(dt,0.512,rig.tractor.forwardSpeed);
  rig.step(dt,ground);
  if(i%(200*4)===0){
    const dw=rig.tractor.wheels.filter(w=>w.driven);
    const tractive=dw.reduce((a,w)=>a+w.longForce,0);
    const load=dw.reduce((a,w)=>a+w.load,0);
    const slip=dw.reduce((a,w)=>a+w.slipRatio,0)/dw.length;
    const p=rig.tractor.body.position; const pr=route.project(p.x,p.z);
    console.log(`t=${(i/200).toFixed(0).padStart(2)}s ${rig.speedMph.toFixed(1).padStart(5)}mph gear=${rig.powertrain.gearLabel.padStart(3)} rpm=${Math.round(rig.powertrain.rpm)} wheelT=${(rig.powertrain.wheelTorque/1000).toFixed(0)}kNm tractive=${(tractive/1000).toFixed(0)}kN driveLoad=${(load/1000).toFixed(0)}kN slip=${slip.toFixed(2)} clutchSlip=${rig.powertrain.clutchSlipping} lat=${pr.lateral.toFixed(1)}`);
  }
}
