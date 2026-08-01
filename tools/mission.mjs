import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';

const route = new Route(); const ground = new Ground(route);
const rig = new Rig({ cargo:{name:'t',mass:68000,size:new Vector3(3.66,3.60,8.40),centerHeight:2.35}});
const startS = route.staging.s;
rig.placeAt(route.positionAt(startS, route.laneWidth*0.5, new Vector3()), route.headingAt(startS), ground);
rig.air.psi=120; rig.air.parkingBrake=false;
const dt=1/120; const proj={};
let lastLog=-1;
for (let i=0;i<120*60*30;i++){
  const p=rig.tractor.body.position; route.project(p.x,p.z,proj); const s=proj.s;
  const look=Math.min(260, 60+Math.abs(rig.speedMph)*6);
  let target=route.advisorySpeedAt(s);
  for(let d=20;d<=look;d+=40) target=Math.min(target, route.advisorySpeedAt(s+d)+4);
  const err=target-rig.speedMph;
  rig.throttle=Math.max(0,Math.min(1,err*0.22));
  rig.brake=Math.max(0,Math.min(0.75,-err*0.10));
  const grade=route.gradeAt(s);
  rig.powertrain.engineBrakeStage = grade<-0.03?3:0;
  if(grade<-0.03) rig.brake=Math.min(rig.brake,0.25);
  const aimS=s+Math.max(18,Math.abs(rig.speedMph)*1.5);
  const aim=route.positionAt(aimS, route.laneWidth*0.5, new Vector3());
  const fwd=rig.tractor.body.localToWorldDir(new Vector3(0,0,1),new Vector3());
  const right=rig.tractor.body.localToWorldDir(new Vector3(1,0,0),new Vector3());
  const toAim=aim.sub(p);
  const steer=Math.atan2(toAim.dot(right), Math.max(1,toAim.dot(fwd)));
  rig.steerInput=Math.max(-1,Math.min(1,steer*2.2));
  rig.powertrain.autoShift(dt,0.512,rig.tractor.forwardSpeed);
  rig.step(dt,ground);

  const km=Math.floor(s/250);
  if(km!==lastLog){ lastLog=km;
    console.log(`s=${String(Math.round(s)).padStart(5)} ${rig.speedMph.toFixed(0).padStart(3)}mph tgt=${target.toFixed(0).padStart(2)} gear=${rig.powertrain.gearLabel.padStart(3)} steer=${rig.steerInput.toFixed(2).padStart(5)} lat=${proj.lateral.toFixed(1).padStart(5)} artic=${(rig.yawA.angle*57.3).toFixed(0).padStart(4)}deg roll=${rig.telemetry.rollover.toFixed(2)} jk=${rig.telemetry.jackknife.toFixed(2)} grade=${(grade*100).toFixed(0)}%`);
  }
  if(rig.telemetry.jackknife>=1.2 || rig.telemetry.rollover>=1.3){
    console.log(`\n*** LOST IT at s=${Math.round(s)} (${(s/1609).toFixed(2)} mi): roll=${rig.telemetry.rollover.toFixed(2)} jk=${rig.telemetry.jackknife.toFixed(2)} speed=${rig.speedMph.toFixed(0)} lat=${proj.lateral.toFixed(1)} steer=${rig.steerInput.toFixed(2)}`);
    break;
  }
  if(s>=route.destination.s){ console.log('\nDELIVERED'); break; }
}
