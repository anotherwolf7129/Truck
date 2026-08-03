import { Vector3 } from 'three';

const _p = new Vector3();
// One projection record per role. `_scratch` belongs to an unhinted heightAt
// call, `_centre` to the point a full sample is being taken at, and `_offset` to
// the four finite-difference probes around it -- so a probe can never overwrite
// the centre projection it was derived from.
const _scratch = {};
const _centre = {};
const _offset = {};

/**
 * How far back from the kerb the ground was graded flat when the place was
 * built, in metres, by what kind of road it is.
 *
 * Exported because the renderer needs the same number: this is where the city
 * stops and the country starts, so it decides both what the wheels find and
 * where the ground stops being drawn as paving.
 */
export const BUILT_UP_SHELF = { downtown: 120, urban: 64, industrial: 70 };

/**
 * Deterministic value noise. Seeded and hash-based so the terrain is identical
 * every run and needs no stored heightmap.
 */
function hash2(x, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967295;
}

function smoothNoise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);

  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);

  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, z, octaves = 4) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += smoothNoise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.05;
  }
  return sum / norm;
}

/**
 * The drivable world.
 *
 * Exposes the single `sample(x, z)` call the vehicle physics needs, returning
 * surface height, normal and grip. The road is a graded, paved ribbon; away
 * from it the ground is rolling terrain that the shoulder blends into, so
 * dropping a wheel off the pavement is both bumpy and slippery -- which on a
 * load this heavy is how you end up in the ditch.
 */
export class Ground {
  constructor(route) {
    this.route = route;
    this.surfaceGrip = { asphalt: 1.0, shoulder: 0.72, dirt: 0.55 };
    this.wetness = 0;

    this._result ={ height: 0, normal: new Vector3(0, 1, 0), grip: 1, surface: 'asphalt' };
  }

  /**
   * Terrain elevation away from the road corridor.
   *
   * Four scales. The broadest is the one that gives the place a horizon: a
   * three-kilometre wavelength worth about fifty metres of relief, which is what
   * puts hills behind the city instead of a flat green plain. Below that the
   * other three carry the rolling ground the freeway runs over, the undulation
   * at field scale and the surface roughness the tires find. Inside the city
   * none of it reaches the road -- the shelf above flattens it -- which is the
   * point: a city is built on ground somebody levelled.
   *
   * The amplitudes are larger than they read: fbm returns a value that spends
   * most of its time near the middle of its range, so the ±23 m the broad term
   * used to be worth was really about ±9 m on the ground -- flat enough that
   * every distant view was a horizontal line.
   */
  terrainHeight(x, z) {
    const hills = (fbm(x * 0.00035, z * 0.00035, 3) - 0.5) * 300;
    const broad = (fbm(x * 0.0016, z * 0.0016, 4) - 0.5) * 70;
    const mid = (fbm(x * 0.011, z * 0.011, 3) - 0.5) * 6.5;
    const fine = (fbm(x * 0.06, z * 0.06, 2) - 0.5) * 0.55;
    return hills + broad + mid + fine;
  }

  /**
   * Surface height at a point.
   *
   * Inside the paved width the road's own elevation wins outright. Outside it,
   * the road grade blends into the terrain over a cut-and-fill band so the
   * shoulder does not end in a cliff.
   *
   * Built-up ground gets a graded shelf first, and how wide that shelf is
   * depends on what is standing on it. A freeway can run along the top of a fill
   * with the ground falling away from the shoulder, but a street with footways,
   * kerbs and buildings on it cannot -- everything within a block of the kerb
   * was levelled when the place was built. Downtown the block is deeper still,
   * because what is on it is a city rather than a row of houses, and a tower
   * standing on a 45 degree bank is not a tower anybody built.
   */
  heightAt(x, z, projection = null) {
    const route = this.route;
    const _proj = projection ?? route.project(x, z, _scratch);
    const dist = Math.abs(_proj.lateral);

    const roadY = route.elevationAt(x, z, _proj);
    const half = route.halfWidthAt(_proj.s);

    if (dist <= half) return roadY;

    const shelf = BUILT_UP_SHELF[route.kindAt(_proj.s)] ?? 0;
    if (dist <= half + shelf) return roadY;

    // Cut and fill, over a distance that follows how much of it there is. A road
    // running two metres above the field beside it needs a few metres of verge
    // to get down; one crossing a valley fifty metres deep is on an embankment
    // hundreds of metres wide, and blending that over the same twenty-six metres
    // would put a wall of earth along the shoulder. The taller the terrain
    // relief now is, the more this matters.
    const terrain = this.terrainHeight(x, z);
    // Roughly a 2:1 side slope, which is what an earthwork embankment is built
    // to, so a fifty-metre fill lands a hundred metres out rather than either
    // dropping off a cliff at the shoulder or flattening the whole valley.
    const blend = shelf + Math.min(300, 22 + Math.abs(roadY - terrain) * 2.2);
    const t = Math.min(1, (dist - half - shelf) / blend);
    // Smoothstep the transition and drop the verge slightly below the pavement.
    const k = t * t * (3 - 2 * t);
    return roadY * (1 - k) + (terrain - 0.35) * k;
  }

  /**
   * A smooth 0..1 field used to tint the ground.
   *
   * Open ground is not one colour. Without something at field scale the terrain
   * reads as a green sheet however much relief is under it, because every
   * triangle is the same shade as its neighbours.
   */
  patchNoise(x, z) {
    return fbm(x * 0.0022, z * 0.0022, 2);
  }

  /**
   * Which surface a point is on, from how far it sits off the centreline.
   *
   * Measured against the pavement at that arc length rather than a fixed width:
   * the same four metres off centre is the middle of the inside lane on the
   * arterial and a wheel in the gravel on the ramp.
   */
  surfaceAt(dist, s) {
    const route = this.route;
    if (dist <= route.edgeOffsetAt(s)) return 'asphalt';
    if (dist <= route.halfWidthAt(s)) return 'shoulder';
    return 'dirt';
  }

  /**
   * Full sample for the physics: height, surface normal and available grip.
   * The normal comes from finite differences of the height field.
   */
  sample(x, z) {
    const route = this.route;
    // One projection for the whole sample. The four probes below are within a
    // metre of it, so they reuse its sample index as a hint instead of going
    // back through the spatial index -- which turns six index queries per wheel
    // per step into one.
    route.project(x, z, _centre);
    const hint = _centre.index;
    const h = this.heightAt(x, z, _centre);

    const e = 1.0;
    const hx = this.probe(x + e, z, hint) - this.probe(x - e, z, hint);
    const hz = this.probe(x, z + e, hint) - this.probe(x, z - e, hint);

    const n = this._result.normal;
    n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();

    const surface = this.surfaceAt(Math.abs(_centre.lateral), _centre.s);
    let grip = this.surfaceGrip[surface];
    // Wet pavement loses far more grip than wet gravel does.
    grip *= 1 - this.wetness * (surface === 'asphalt' ? 0.32 : 0.18);

    this._result.height = h;
    this._result.grip = grip;
    this._result.surface = surface;
    this._result.index = hint;
    return this._result;
  }

  /** Height at a point known to be beside a sample we have already found. */
  probe(x, z, hint) {
    this.route.projectNear(x, z, hint, _offset);
    return this.heightAt(x, z, _offset);
  }

  /** Height of the road surface directly, ignoring terrain. Used by the AI. */
  roadHeightAt(s, lateral = 0) {
    this.route.positionAt(s, lateral, _p);
    return _p.y;
  }
}
