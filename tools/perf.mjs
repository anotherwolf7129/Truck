/**
 * Where the frame actually goes.
 *
 * Runs the simulation headlessly at a fixed wall-clock budget and reports the
 * cost of each part of a frame in microseconds, plus how much of a 60 Hz budget
 * (16.7 ms) the simulation eats before the renderer has drawn anything.
 *
 * The renderer is not measured here -- that needs a GPU and a real page -- but
 * the simulation is pure CPU, it runs on the main thread, and it is what decides
 * whether there is any budget left for drawing.
 */
import { Vector3 } from 'three';
import { Route } from '../src/world/Route.js';
import { Ground } from '../src/world/Ground.js';
import { Rig } from '../src/physics/Rig.js';
import { ConvoyManager } from '../src/ai/Escort.js';
import { TrafficManager } from '../src/ai/Traffic.js';

const FIXED_DT = 1 / 200;
const FRAME = 1 / 60;
const FRAMES = Number(process.argv[2] ?? 600);

const route = new Route();
const ground = new Ground(route);
const rig = new Rig({
  cargo: {
    name: 'Substation transformer, 400 MVA',
    mass: 68000,
    size: new Vector3(3.66, 3.60, 8.40),
    centerHeight: 2.35,
  },
});
const convoy = new ConvoyManager(route, rig);
const traffic = new TrafficManager(route, { density: 1 });

const startS = 1000;
rig.placeAt(route.positionAt(startS, route.convoyLaneOffset(startS), new Vector3()),
  route.headingAt(startS), ground);
rig.air.psi = 120;
rig.air.parkingBrake = false;
convoy.reset(startS);
for (let i = 0; i < 400; i++) rig.step(FIXED_DT, ground);

// Get it rolling so the traffic and escorts have something to react to.
rig.throttle = 0.7;
for (let i = 0; i < 200 * 20; i++) rig.step(FIXED_DT, ground);

const timers = { physics: 0, route: 0, convoy: 0, traffic: 0 };
const t0 = process.hrtime.bigint();
let steps = 0;

for (let f = 0; f < FRAMES; f++) {
  let a = process.hrtime.bigint();
  for (let i = 0; i < Math.round(FRAME / FIXED_DT); i++) { rig.step(FIXED_DT, ground); steps++; }
  let b = process.hrtime.bigint();
  timers.physics += Number(b - a);

  a = b;
  const p = route.project(rig.tractor.body.position.x, rig.tractor.body.position.z);
  const convoyS = p.s;
  const speed = rig.tractor.forwardSpeed;
  route.advisorySpeedAt(convoyS);
  route.halfWidthAt(convoyS);
  b = process.hrtime.bigint();
  timers.route += Number(b - a);

  const load = { lateral: p.lateral, halfWidth: 1.83, length: convoy.convoyLength };
  a = b;
  convoy.traffic = traffic.vehicles;
  convoy.update(FRAME, convoyS, speed, 4.15, load);
  b = process.hrtime.bigint();
  timers.convoy += Number(b - a);

  a = b;
  traffic.update(FRAME, {
    convoy: { s: convoyS, speed, ...load },
    escorts: convoy.vehicles,
    blockades: convoy.blockades,
    route,
  });
  b = process.hrtime.bigint();
  timers.traffic += Number(b - a);
}

const total = Number(process.hrtime.bigint() - t0) / 1e6;
const per = (ns) => (ns / FRAMES / 1000).toFixed(0).padStart(6) + ' us';

console.log(`${FRAMES} frames, ${steps} physics steps, ${total.toFixed(0)} ms wall\n`);
console.log(`  physics   ${per(timers.physics)}`);
console.log(`  route     ${per(timers.route)}`);
console.log(`  convoy    ${per(timers.convoy)}`);
console.log(`  traffic   ${per(timers.traffic)}`);
console.log(`  ---------------------`);
console.log(`  sim/frame ${(total / FRAMES).toFixed(2)} ms   ` +
  `${((total / FRAMES) / (FRAME * 1000) * 100).toFixed(0)}% of a 60 Hz frame`);
console.log(`  traffic on the road: ${traffic.vehicles.length}`);
