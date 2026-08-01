// Static load analysis used to size the rig geometry and spring rates.
const g = 9.81;
const kN = (n) => (n/1000).toFixed(1);
const lb = (n) => Math.round(n*0.2248089431).toLocaleString();

const cargo = 68000, tare = 14000, trailerMass = cargo + tare;
const jeepMass = 5000, tractorMass = 9500;

// Trailer: gooseneck pin at +6.30, axle centroid of [-4.10,-5.45,-6.80,-8.15]
const axleC = (-4.10-5.45-6.80-8.15)/4;
const W_tr = trailerMass*g;
const gooseFrac = (0 - axleC)/(6.30 - axleC);
const goose = W_tr*gooseFrac, lowboyAxles = W_tr - goose;
console.log(`trailer  ${kN(W_tr)} kN -> gooseneck ${kN(goose)} (${lb(goose)} lb), lowboy axles ${kN(lowboyAxles)} (${lb(lowboyAxles)} lb)`);
console.log(`  per lowboy wheel ${kN(lowboyAxles/8)} kN`);

// Jeep: kingpin +2.20, axles [-1.00,-2.35] centroid, rear fifth wheel at zFW
const jAxleC = (-1.00-2.35)/2, zFW = -0.30;
const W_j = jeepMass*g, sum = W_j + goose;
const K = (W_j*(0-jAxleC) + goose*(zFW-jAxleC)) / (2.20-jAxleC);
console.log(`jeep     kingpin->tractor ${kN(K)} kN (${lb(K)} lb), jeep axles ${kN(sum-K)} kN, per wheel ${kN((sum-K)/4)}`);

// Tractor: steer +2.20, drives centroid, fifth wheel -2.10
const tAxleC = (-1.55-2.90)/2, zFifth = -2.10;
const W_t = tractorMass*g, tsum = W_t + K;
const S = (W_t*(0-tAxleC) + K*(zFifth-tAxleC)) / (2.20-tAxleC);
console.log(`tractor  STEER ${kN(S)} kN (${lb(S)} lb), DRIVES ${kN(tsum-S)} kN (${lb(tsum-S)} lb)`);
console.log(`  per steer wheel ${kN(S/2)} kN, per drive wheel ${kN((tsum-S)/4)} kN`);

console.log(`\nGROSS ${lb((trailerMass+jeepMass+tractorMass)*g)} lb`);
console.log('\nspring sizing (target ~38% of travel at static load):');
const spec = (name, load, stiff, dual, travel) => {
  const k = dual ? stiff*1.55 : stiff;
  const c = load/k;
  console.log(`  ${name.padEnd(10)} k_eff=${(k/1000).toFixed(0)} kN/m  comp=${(c*1000).toFixed(0)}mm  ${(c/travel*100).toFixed(0)}% of ${travel*1000}mm travel`);
};
spec('steer', S/2, 480000, false, 0.14);
spec('drive', (tsum-S)/4, 560000, true, 0.17);
spec('jeep', (sum-K)/4, 780000, true, 0.15);
spec('lowboy', lowboyAxles/8, 700000, true, 0.16);
