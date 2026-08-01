import { Vector3, CatmullRomCurve3 } from 'three';

const _a = new Vector3();
const _b = new Vector3();

/**
 * The permitted route.
 *
 * A heavy haul move is not free driving -- it is a surveyed corridor that the
 * permit office approved, with every obstruction on it known in advance. The
 * route therefore owns not just a centreline but the list of things the escort
 * crew has to manage: side roads to block, a bridge with a posted clearance, a
 * corner too tight to take without swinging wide, and a grade long enough to
 * cook the brakes.
 */
export class Route {
  constructor() {
    // Control points: x, elevation, z. The move runs out of an industrial yard,
    // across farmland, over a ridge by way of a switchback, down a long grade
    // into the valley, then through the edge of town to the substation.
    const pts = [
      [0, 0, 0],
      [0, 0, 260],
      [0, 0, 620],
      [30, 2, 980],
      [110, 5, 1320],
      [220, 8, 1620],
      [360, 10, 1880],
      [520, 12, 2100],
      [700, 16, 2300],
      [880, 24, 2500],
      [1030, 36, 2700],
      [1140, 52, 2910],
      [1190, 70, 3140],
      [1160, 88, 3380],
      [1050, 102, 3600],
      [880, 110, 3780],
      [690, 112, 3920],
      // Switchback over the ridge -- the tightest thing on the route.
      [540, 110, 4030],
      [470, 106, 4160],
      [500, 100, 4300],
      [610, 92, 4400],
      [740, 80, 4500],
      [840, 64, 4640],
      [900, 46, 4830],
      [920, 30, 5060],
      [900, 18, 5300],
      [840, 10, 5540],
      [740, 5, 5760],
      [600, 2, 5950],
      [430, 0, 6110],
      [240, 0, 6250],
      [40, 0, 6380],
      [-170, 0, 6500],
      [-390, 0, 6620],
      [-610, 1, 6760],
      [-810, 3, 6930],
      [-980, 6, 7140],
      [-1110, 8, 7380],
      [-1190, 9, 7640],
      [-1220, 10, 7920],
      [-1200, 10, 8200],
      [-1130, 10, 8470],
      [-1010, 10, 8720],
      [-850, 10, 8940],
      [-660, 10, 9120],
      [-450, 10, 9260],
      [-230, 10, 9360],
      [0, 10, 9430],
      [240, 10, 9480],
    ];

    this.curve = new CatmullRomCurve3(
      pts.map(([x, y, z]) => new Vector3(x, y, z)),
      false,
      'catmullrom',
      0.5
    );

    this.laneWidth = 3.7;
    this.shoulderWidth = 2.4;
    this.roadHalfWidth = this.laneWidth + this.shoulderWidth;

    this.buildSamples(2400);

    // --- Route features ----------------------------------------------------
    // Side roads the escorts have to hold while the load goes through. `side`
    // is which way the junction leaves the highway.
    this.junctions = [
      { s: 640, name: 'Kesler Road', side: -1 },
      { s: 1450, name: 'Old Mill Road', side: 1 },
      { s: 2260, name: 'County Route 9', side: -1, signal: true },
      { s: 3080, name: 'Quarry Road', side: 1 },
      { s: 4380, name: 'Ridge Fire Road', side: -1 },
      { s: 6180, name: 'Harmon Pike', side: 1 },
      { s: 7350, name: 'Valley Road', side: -1, signal: true },
      { s: 8600, name: 'Beltline Connector', side: 1, signal: true },
      { s: 9900, name: 'Cement Plant Road', side: -1 },
      { s: 11250, name: 'Substation Access', side: 1 },
    ];

    // Posted vertical clearances. The lead pilot car carries a height pole set
    // just above the load; if the pole hits, the load would have hit.
    this.bridges = [
      { s: 1900, name: 'CR-9 overpass', clearance: 5.18, span: 14 },
      { s: 7000, name: 'Norfolk Southern bridge', clearance: 5.02, span: 18 },
      { s: 10400, name: 'Beltline underpass', clearance: 5.35, span: 22 },
    ];

    // Corners the survey flagged as too tight to take at speed, where the
    // trailer's rear axles have to be steered to keep the load in its lane.
    // The switchback is the reason this move needs a steerman at all.
    this.tightCorners = [
      { s: 4840, name: 'Ridge Road switchback', advisoryMph: 8, radius: 159 },
      { s: 6600, name: 'Valley Road bend', advisoryMph: 15, radius: 480 },
    ];

    // The long descent off the ridge. Nine percent for the better part of a
    // mile is where a loaded rig cooks its brakes if the driver rides them
    // instead of gearing down.
    this.grades = [
      { start: 5000, end: 6200, name: 'Ridge grade', percent: -9 },
    ];

    this.staging = { s: 40, name: 'Bennett Heavy Haul yard' };
    this.destination = { s: 11800, name: 'Cloverdale Substation' };
  }

  /**
   * Precomputes evenly spaced samples so that arc length, projection and
   * elevation lookups are all cheap at run time.
   */
  buildSamples(count) {
    this.samples = [];
    this.length = 0;

    const raw = this.curve.getSpacedPoints(count);
    let acc = 0;
    for (let i = 0; i < raw.length; i++) {
      if (i > 0) acc += raw[i].distanceTo(raw[i - 1]);
      const tangent = this.curve.getTangentAt(i / (raw.length - 1)).normalize();
      // Lateral axis, level with the world so the road banks only where we say.
      const lateral = new Vector3(tangent.z, 0, -tangent.x).normalize();
      this.samples.push({ s: acc, position: raw[i].clone(), tangent, lateral });
    }
    this.length = acc;

    // Uniform bucket index over the XZ plane for fast nearest-sample queries.
    this.cell = 40;
    this.grid = new Map();
    for (let i = 0; i < this.samples.length; i++) {
      const p = this.samples[i].position;
      const key = this.cellKey(p.x, p.z);
      // Register in the sample's own cell and its neighbours so a lookup only
      // ever has to read one bucket.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = `${Math.floor(p.x / this.cell) + dx},${Math.floor(p.z / this.cell) + dz}`;
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          if (list[list.length - 1] !== i) list.push(i);
        }
      }
      void key;
    }
  }

  cellKey(x, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }

  /** Sample at arc length `s`, clamped to the route. */
  at(s, out = {}) {
    const clamped = Math.max(0, Math.min(this.length, s));
    const i = Math.min(
      this.samples.length - 1,
      Math.max(0, Math.round((clamped / this.length) * (this.samples.length - 1)))
    );
    const sample = this.samples[i];
    out.position = sample.position;
    out.tangent = sample.tangent;
    out.lateral = sample.lateral;
    out.s = sample.s;
    return out;
  }

  /** Heading in radians at arc length `s`. */
  headingAt(s) {
    const { tangent } = this.at(s);
    return Math.atan2(tangent.x, tangent.z);
  }

  /**
   * World position of a point on the route, offset laterally.
   * @param lateral metres right of the centreline
   */
  positionAt(s, lateral = 0, out = new Vector3()) {
    const sample = this.at(s);
    out.copy(sample.position).addScaledVector(sample.lateral, lateral);
    return out;
  }

  /**
   * Projects a world position onto the route.
   * @returns { s, lateral, distance } where `lateral` is signed metres right of
   *          the centreline.
   */
  project(x, z, out = {}) {
    const candidates = this.grid.get(this.cellKey(x, z));
    let best = -1;
    let bestD = Infinity;

    if (candidates) {
      for (const i of candidates) {
        const p = this.samples[i].position;
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best < 0) {
      // Far off route: fall back to a coarse scan so the query never fails.
      for (let i = 0; i < this.samples.length; i += 8) {
        const p = this.samples[i].position;
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < bestD) { bestD = d; best = i; }
      }
    }

    const sample = this.samples[best];
    _a.set(x - sample.position.x, 0, z - sample.position.z);
    const along = _a.dot(sample.tangent);
    const lateral = _a.dot(sample.lateral);

    out.s = Math.max(0, Math.min(this.length, sample.s + along));
    out.lateral = lateral;
    out.distance = Math.sqrt(bestD);
    out.index = best;
    return out;
  }

  /**
   * Road surface elevation at a point, with camber shed off the crown.
   *
   * The elevation is interpolated between samples rather than snapped to the
   * nearest one. Snapping turns a smooth grade into a staircase of centimetre
   * steps, and with two dozen wheels spread over 87 feet the rig ends up riding
   * several different steps at once -- which reads as phantom axle load and a
   * permanent shudder through the suspension.
   */
  elevationAt(x, z, projection = null) {
    const proj = projection ?? this.project(x, z);
    const camber = -Math.min(Math.abs(proj.lateral), this.roadHalfWidth) * 0.02;
    return this.elevationAtS(proj.s) + camber;
  }

  /** Interpolated centreline elevation at arc length `s`. */
  elevationAtS(s) {
    const n = this.samples.length;
    const spacing = this.length / (n - 1);
    const f = Math.max(0, Math.min(n - 1, s / spacing));
    const i0 = Math.min(n - 1, Math.floor(f));
    const i1 = Math.min(n - 1, i0 + 1);
    const t = f - i0;
    const y0 = this.samples[i0].position.y;
    const y1 = this.samples[i1].position.y;
    return y0 + (y1 - y0) * t;
  }

  /** The next junction ahead of arc length `s`, or null. */
  nextJunction(s) {
    for (const j of this.junctions) if (j.s > s) return j;
    return null;
  }

  /** The next bridge ahead of arc length `s`, or null. */
  nextBridge(s) {
    for (const b of this.bridges) if (b.s > s) return b;
    return null;
  }

  /** The next flagged corner ahead of arc length `s`, or null. */
  nextTightCorner(s) {
    for (const c of this.tightCorners) if (c.s > s) return c;
    return null;
  }

  /**
   * Road grade at arc length `s`, as a fraction (0.06 = 6% climb).
   * A sustained downgrade is what puts the brakes in trouble.
   */
  gradeAt(s, window = 40) {
    const a = this.at(s - window / 2);
    const b = this.at(s + window / 2);
    _a.copy(b.position).sub(a.position);
    const run = Math.hypot(_a.x, _a.z);
    return run > 0.01 ? _a.y / run : 0;
  }

  /**
   * Signed curvature at arc length `s`, 1/metres. Positive turns right.
   *
   * The sign is what lets an AI driver point its front wheels the way the road
   * actually goes instead of tracking the centreline with the wheels straight.
   */
  signedCurvatureAt(s, window = 30) {
    const h1 = this.headingAt(s - window / 2);
    const h2 = this.headingAt(s + window / 2);
    let d = h2 - h1;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d / window;
  }

  /** Curvature at arc length `s`, 1/metres. Used for advisory speeds. */
  curvatureAt(s, window = 30) {
    return Math.abs(this.signedCurvatureAt(s, window));
  }

  /**
   * Highest speed the loaded rig should see here, mph, from curvature and any
   * posted advisory. This is what the lead pilot car calls back over the radio.
   */
  advisorySpeedAt(s) {
    let mph = 45;
    const k = this.curvatureAt(s);
    if (k > 1e-4) {
      // Hold the load to about 0.15 g laterally, well inside its roll limit.
      const radius = 1 / k;
      mph = Math.min(mph, Math.sqrt(0.15 * 9.81 * radius) * 2.23694);
    }
    for (const c of this.tightCorners) {
      if (Math.abs(c.s - s) < 90) mph = Math.min(mph, c.advisoryMph);
    }
    const grade = this.gradeAt(s);
    if (grade < -0.04) mph = Math.min(mph, 25);
    return Math.max(5, mph);
  }
}
