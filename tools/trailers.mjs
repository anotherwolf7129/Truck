import { TRAILER_CONFIGS, loadSplit } from '../src/physics/Trailers.js';
const lb = (n) => Math.round(n * 0.2248089431).toLocaleString();
const TRACTOR = 9500, JEEP = 5000;
console.log('Static load analysis per trailer configuration:\n');
for (const c of TRAILER_CONFIGS) {
  const s = loadSplit(c);
  const gross = (TRACTOR + JEEP + s.mass) * 9.81;
  const len = c.gooseneckZ - c.axleZ[c.axleZ.length-1] + 4.60 + 4.30 + 4.0;
  // spring rate that puts static compression at ~47 mm on a dual position
  const stiffness = s.perWheelN / (1.55 * 0.047);
  console.log(`${c.name}`);
  console.log(`  gross          ${lb(gross)} lb   combination ~${(len*3.28084).toFixed(0)} ft`);
  console.log(`  load height    ${((0.55 + c.cargo.size.y) * 3.28084).toFixed(2)} ft   width ${(c.cargo.size.x*3.28084).toFixed(1)} ft`);
  console.log(`  split          gooseneck ${(s.gooseneckFraction*100).toFixed(0)}% / axles ${(s.axleFraction*100).toFixed(0)}%`);
  console.log(`  lowboy axles   ${lb(s.axleLoadN)} lb over ${c.axleZ.length} axles = ${lb(s.perWheelN)} lb per wheel position`);
  console.log(`  spring rate    ${(stiffness/1000).toFixed(0)} kN/m per wheel`);
  console.log('');
}
