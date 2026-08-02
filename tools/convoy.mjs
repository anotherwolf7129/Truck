import { Route } from '../src/world/Route.js';
import { ConvoyManager } from '../src/ai/Escort.js';
import { TrafficManager } from '../src/ai/Traffic.js';

const route = new Route();
console.log(`route length ${route.length.toFixed(0)} m (${(route.length/1609).toFixed(1)} mi), ${route.junctions.length} junctions\n`);

const convoy = new ConvoyManager(route, null);
const traffic = new TrafficManager(route, { density: 1 });
convoy.reset(30);

const dt = 1/30;
let s = 30, speed = 0;
const events = [];
convoy.radio.listeners.push(m => events.push(`  [${(convoy.time/60).toFixed(1)}min @ ${(s/1609).toFixed(2)}mi] ${m.from}: ${m.text}`));

let blockedInTime = 0, missed = 0;
const yieldStates = new Map();
const seen = new Set();

for (let i = 0; i < 30*60*60; i++) {   // up to an hour
  const advisory = route.advisorySpeedAt(s) / 2.23694;
  speed += Math.max(-1.2*dt, Math.min(0.5*dt, advisory - speed));
  s += speed * dt;
  if (s > route.length - 40) break;
  convoy.update(dt, s, speed, 4.95);
  traffic.update(dt, { convoy: { s, speed, length: 27 }, blockades: convoy.blockades, route });
  for (const v of traffic.vehicles) yieldStates.set(v.state, (yieldStates.get(v.state)||0)+1);

  // Did each junction get blocked before the load reached it?
  for (const b of convoy.blockades) {
    if (!seen.has(b.name) && s > b.s - 5) {
      seen.add(b.name);
      if (b.active) {
        blockedInTime++;
        const held = b.signalised
          ? `unit has the light, ${b.cross?.vehicles.length ?? 0} on the cross street`
          : `unit held it, ${b.queue.length} cars waiting`;
        console.log(`  OK   ${b.name.padEnd(22)} blocked before load arrived (${held})`);
      }
      else { missed++; console.log(`  MISS ${b.name.padEnd(22)} NOT blocked when load arrived`); }
    }
  }
}
console.log(`\nblocked in time: ${blockedInTime}/${blockedInTime+missed}`);
console.log('traffic vehicle-frames by state:', [...yieldStates].map(([k,v])=>`${k}=${v}`).join(' '));
console.log(`\nradio log (${events.length} calls):`);
console.log(events.slice(0, 26).join('\n'));
