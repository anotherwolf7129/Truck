import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';
import { TRAILER_CONFIGS, loadSplit } from '../src/physics/Trailers.js';

const route = new Route(), ground = new Ground(route);
const dt = 1/200;
for (const c of TRAILER_CONFIGS) {
  const rig = new Rig({ trailer: c.id });
  const s0 = 7600;
  rig.placeAt(route.positionAt(s0, route.laneWidth*0.5, new Vector3()), route.headingAt(s0), ground);
  rig.air.psi=120; rig.air.parkingBrake=false;
  for (let i=0;i<2000;i++) rig.step(dt, ground);
  // time-average once settled
  const acc = {}; let n=0, sup=0;
  for (let i=0;i<1200;i++){ rig.step(dt, ground);
    for (const g of rig.axleWeights()) acc[g.label]=(acc[g.label]||0)+g.lb;
    sup += rig.units.reduce((a,u)=>a+u.axleLoad,0); n++; }
  const weightN = rig.units.reduce((a,u)=>a+u.body.mass,0)*9.81;
  const split = loadSplit(c);
  console.log(`${c.name}`);
  console.log(`  supported ${(sup/n/1000).toFixed(0)} kN vs weight ${(weightN/1000).toFixed(0)} kN  (${(sup/n/weightN*100).toFixed(0)}%)`);
  console.log(`  ` + Object.entries(acc).map(([k,v])=>`${k} ${Math.round(v/n).toLocaleString()}`).join('   '));
  console.log(`  predicted lowboy ${Math.round(split.axleLoadN*0.2248).toLocaleString()} lb\n`);
}
