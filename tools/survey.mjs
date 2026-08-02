/**
 * Surveys the route: length, grades, and every corner on it.
 *
 * A permit route is only worth driving if the corners are corners. This walks
 * the centreline and reports each place the heading turns through more than a
 * few degrees -- how far round it goes, the radius it goes round at, and the
 * advisory speed that falls out of that -- so the shape of the road can be
 * designed against numbers rather than guessed at and then driven to find out.
 *
 * A superload turning off one road onto another does it at a radius in the
 * region of a hundred metres. Much under sixty and an 87 ft combination does not
 * fit round it whatever the escorts do.
 */
import { Route } from '../src/world/Route.js';

const route = new Route();
const STEP = 5;

console.log(`length      ${route.length.toFixed(0)} m  (${(route.length / 1609.34).toFixed(2)} mi)`);

// --- Corners ----------------------------------------------------------------
// A corner is a run of stations that all bend the same way. Walk the route,
// accumulate heading change while the sign holds, and close the corner off when
// the road straightens or turns back.
const corners = [];
let open = null;
let prev = route.headingAt(0);

for (let s = STEP; s <= route.length; s += STEP) {
  const h = route.headingAt(s);
  let d = h - prev;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  prev = h;

  const rate = d / STEP;                     // radians per metre
  const turning = Math.abs(rate) > 1 / 900;  // radius under 900 m counts

  if (turning && open && Math.sign(rate) === open.sign) {
    open.total += d;
    open.to = s;
    open.peak = Math.max(open.peak, Math.abs(rate));
  } else if (turning) {
    if (open) corners.push(open);
    open = { from: s, to: s, total: d, sign: Math.sign(rate), peak: Math.abs(rate) };
  } else if (open && s - open.to > 60) {
    corners.push(open);
    open = null;
  }
}
if (open) corners.push(open);

console.log('\ncorner        at        through   min radius   advisory');
for (const c of corners) {
  const deg = Math.abs(c.total) * 180 / Math.PI;
  if (deg < 12) continue;
  const radius = 1 / c.peak;
  const mid = (c.from + c.to) / 2;
  console.log(
    `  ${c.sign > 0 ? 'right' : 'left '}    ${String(Math.round(mid)).padStart(6)} m  `
    + `${deg.toFixed(0).padStart(5)} deg  ${radius.toFixed(0).padStart(8)} m  `
    + `${route.advisorySpeedAt(mid).toFixed(0).padStart(6)} mph`
  );
}

// --- Grades -----------------------------------------------------------------
let steepest = { s: 0, grade: 0 };
let climb = { s: 0, grade: 0 };
for (let s = 0; s <= route.length; s += 20) {
  const g = route.gradeAt(s);
  if (g < steepest.grade) steepest = { s, grade: g };
  if (g > climb.grade) climb = { s, grade: g };
}
console.log(`\nsteepest descent  ${(steepest.grade * 100).toFixed(1)}% at ${steepest.s} m`);
console.log(`steepest climb    ${(climb.grade * 100).toFixed(1)}% at ${climb.s} m`);

// --- Features against the geometry they are declared for --------------------
console.log('\nfeature stations');
for (const j of route.junctions) {
  console.log(`  junction  ${String(j.s).padStart(6)} m  ${j.name}`
    + `   radius ${(1 / Math.max(1e-6, route.curvatureAt(j.s))).toFixed(0)} m`
    + `   ${route.kindAt(j.s)}`);
}
for (const b of route.bridges) console.log(`  bridge    ${String(b.s).padStart(6)} m  ${b.name}`);
for (const c of route.tightCorners) {
  // The station is where the turn starts, so the tightest part of it is some way
  // past that -- measuring at the station itself reads the entry, where the
  // curvature is still ramping in.
  let peak = 0;
  for (let s = c.s; s < c.s + 320; s += 5) peak = Math.max(peak, route.curvatureAt(s));
  console.log(`  corner    ${c.s.toFixed(0).padStart(6)} m  ${c.name.padEnd(24)}`
    + ` declared ${String(c.radius).padStart(4)} m, measured ${(1 / Math.max(1e-6, peak)).toFixed(0)} m`);
}
console.log(`  destination ${route.destination.s} m of ${route.length.toFixed(0)} m`);
