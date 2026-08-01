import { Vector3 } from 'three';

const _p = new Vector3();
const _proj = {};

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

    // Cache of recent samples. The rig alone queries this ~40 times a step and
    // most of those land in the same few square metres.
    this._cache = new Map();
    this._cacheStamp = 0;

    this._result = { height: 0, normal: new Vector3(0, 1, 0), grip: 1, surface: 'asphalt' };
  }

  /** Terrain elevation away from the road corridor. */
  terrainHeight(x, z) {
    const broad = (fbm(x * 0.0016, z * 0.0016, 4) - 0.5) * 46;
    const mid = (fbm(x * 0.011, z * 0.011, 3) - 0.5) * 5.5;
    const fine = (fbm(x * 0.06, z * 0.06, 2) - 0.5) * 0.55;
    return broad + mid + fine;
  }

  /**
   * Surface height at a point.
   *
   * Inside the paved width the road's own elevation wins outright. Outside it,
   * the road grade blends into the terrain over a cut-and-fill band so the
   * shoulder does not end in a cliff.
   */
  heightAt(x, z) {
    const route = this.route;
    route.project(x, z, _proj);
    const dist = Math.abs(_proj.lateral);

    const roadY = route.elevationAt(x, z, _proj);
    const half = route.roadHalfWidth;

    if (dist <= half) return roadY;

    const blend = 26; // metres of cut-and-fill either side
    const t = Math.min(1, (dist - half) / blend);
    const terrain = this.terrainHeight(x, z);
    // Smoothstep the transition and drop the verge slightly below the pavement.
    const k = t * t * (3 - 2 * t);
    return roadY * (1 - k) + (terrain - 0.35) * k;
  }

  surfaceAt(dist) {
    const route = this.route;
    if (dist <= route.laneWidth * 2) return 'asphalt';
    if (dist <= route.roadHalfWidth) return 'shoulder';
    return 'dirt';
  }

  /**
   * Full sample for the physics: height, surface normal and available grip.
   * The normal comes from finite differences of the height field.
   */
  sample(x, z) {
    const h = this.heightAt(x, z);
    const e = 1.0;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);

    const n = this._result.normal;
    n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();

    this.route.project(x, z, _proj);
    const surface = this.surfaceAt(Math.abs(_proj.lateral));
    let grip = this.surfaceGrip[surface];
    // Wet pavement loses far more grip than wet gravel does.
    grip *= 1 - this.wetness * (surface === 'asphalt' ? 0.32 : 0.18);

    this._result.height = h;
    this._result.grip = grip;
    this._result.surface = surface;
    return this._result;
  }

  /** Height of the road surface directly, ignoring terrain. Used by the AI. */
  roadHeightAt(s, lateral = 0) {
    this.route.positionAt(s, lateral, _p);
    return _p.y;
  }
}
