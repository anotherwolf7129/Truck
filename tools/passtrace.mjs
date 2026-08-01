import { Route } from '../src/world/Route.js';
import { ConvoyManager } from '../src/ai/Escort.js';
import { TrafficManager } from '../src/ai/Traffic.js';

const route = new Route();
const LEN = 26;
const convoy = new ConvoyManager(route, { combinationLength: LEN });
const traffic = new TrafficManager(route, { density: 1 });
let s = 8150, speed = 20/2.23694;
convoy.reset(s);
const dt = 1/30;
const loadLat = route.laneWidth * 0.5;

console.log('A police unit running up past the load to take the next junction.');
console.log('(lateral is metres right of the centreline; the load occupies 0.0 to 3.7)\n');
console.log('  t    unit   state     s-rel   lateral  clearance  heading-vs-route');
let last = -99;
for (let i = 0; i < 30*220; i++) {
  s += speed*dt;
  convoy.update(dt, s, speed, 4.15);
  traffic.update(dt, { convoy:{s,speed,length:LEN}, chaseS: convoy.rearGuardS, blockades: convoy.blockades, route });
  const t = i*dt;
  for (const u of convoy.vehicles) {
    if (!u.isPolice || u.state === 'blocking') continue;
    const rel = u.s - s;
    if (rel < -120 || rel > 60) continue;
    if (t - last < 1.2) continue;
    last = t;
    // Only meaningful when the unit is actually beside the load; 60 m behind it
    // the lateral offset says nothing about clearance.
    const overlapping = u.s > s - LEN - u.length && u.s < s + u.length;
    const clear = overlapping
      ? (Math.abs(u.lateral - loadLat) - (1.83 + u.width/2)).toFixed(2) + 'm'
      : '     -';
    let dh = u.heading - route.headingAt(u.s);
    while (dh > Math.PI) dh -= Math.PI*2;
    while (dh < -Math.PI) dh += Math.PI*2;
    console.log(`${t.toFixed(0).padStart(5)}s  ${convoy.unitName(u).padEnd(7)} ${u.state.padEnd(8)} ` +
      `${rel.toFixed(0).padStart(5)}m  ${u.lateral.toFixed(2).padStart(6)}  ${String(clear).padStart(9)}  ${(dh*57.3).toFixed(1).padStart(6)} deg`);
  }
}
const queued = traffic.vehicles.filter(v=>v.state==='following-convoy').length;
console.log(`\ntraffic queued behind the convoy right now: ${queued}`);
