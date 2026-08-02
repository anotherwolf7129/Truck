import { Vector3, CatmullRomCurve3 } from 'three';
import { Corridor } from './Corridor.js';
import { SignalNetwork } from './Signal.js';

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

    // --- Cross-section ------------------------------------------------------
    // The route is four different roads. It leaves the yard on a two-lane county
    // highway, narrows over the ridge, and comes into Cloverdale as a five-lane
    // suburban arterial -- two lanes each way either side of a centre turn lane,
    // with a signal every quarter mile. Nearly everything the other vehicles on
    // the road do follows from which of those they are currently on.
    this.corridor = new Corridor([
      { s: 0, name: 'Bennett yard road', kind: 'industrial', lanes: 1, median: 0, shoulder: 2.6, limitMph: 30 },
      { s: 320, name: 'County Highway 14', kind: 'rural', lanes: 1, median: 0, shoulder: 2.4, limitMph: 45 },
      { s: 3400, name: 'Ridge Road', kind: 'mountain', lanes: 1, median: 0, shoulder: 1.3, limitMph: 35 },
      { s: 6400, name: 'Valley Road', kind: 'rural', lanes: 1, median: 0, shoulder: 2.4, limitMph: 45 },
      // The town line. The extra lane opens over a 140 m taper, which is why the
      // pavement widens well before there is a second lane to drive in.
      { s: 8180, name: 'Cloverdale Pike', kind: 'suburban', lanes: 2, median: 3.7, shoulder: 1.6, limitMph: 35, taper: 140 },
      { s: 11400, name: 'Substation approach', kind: 'industrial', lanes: 1, median: 0, shoulder: 2.2, limitMph: 25, taper: 120 },
    ], { laneWidth: this.laneWidth });

    // Widest the road ever gets. Callers that need a single number -- spatial
    // bucketing, the terrain skirt, how far off the road counts as lost -- use
    // this; anything that cares where the pavement actually is asks for the
    // width at an arc length instead.
    this.roadHalfWidth = this.corridor.maxHalfWidth;

    this.buildSamples(2400);

    // --- Route features ----------------------------------------------------
    // Side roads the escorts have to hold while the load goes through. `side` is
    // which way the junction leaves the highway; `crossing` marks a full
    // four-way, which is a road going both ways rather than a road ending on
    // this one. Signalised junctions are held by taking the light rather than by
    // parking a unit across the mouth.
    this.junctions = [
      { s: 640, name: 'Kesler Road', side: -1 },
      { s: 1450, name: 'Old Mill Road', side: 1 },
      { s: 2260, name: 'County Route 9', side: -1, signal: true, crossing: true },
      { s: 3080, name: 'Quarry Road', side: 1 },
      { s: 4380, name: 'Ridge Fire Road', side: -1 },
      { s: 6180, name: 'Harmon Pike', side: 1 },
      { s: 7350, name: 'Valley Road', side: -1, signal: true, crossing: true },
      // --- Cloverdale ------------------------------------------------------
      { s: 8600, name: 'Beltline Connector', side: 1, signal: true, crossing: true },
      { s: 9080, name: 'Maple Street', side: -1 },
      { s: 9500, name: 'Fairview Drive', side: 1, signal: true, crossing: true },
      { s: 9900, name: 'Cement Plant Road', side: -1 },
      { s: 10340, name: 'Sycamore Lane', side: 1 },
      { s: 10760, name: 'Cloverdale Center', side: -1, signal: true, crossing: true },
      { s: 11250, name: 'Substation Access', side: 1 },
    ];

    // The signal controllers. They live on the route because both the escorts
    // and the ambient traffic have to read the same lights; the convoy manager
    // is what ticks them, since holding a light is escort work.
    this.signals = new SignalNetwork(this);

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

    // Scratch sample records, so the hot lookups below never allocate. Each one
    // is owned by exactly one method: sharing them would mean a call made in the
    // middle of another one silently rewrote its result.
    this._scratchA = {};
    this._scratchB = {};
    this._scratchC = {};

    const raw = this.curve.getSpacedPoints(count);
    let acc = 0;
    for (let i = 0; i < raw.length; i++) {
      if (i > 0) acc += raw[i].distanceTo(raw[i - 1]);
      const tangent = this.curve.getTangentAt(i / (raw.length - 1)).normalize();
      // Lateral axis: the driver's right, level with the world so the road banks
      // only where we say. In a right-handed frame with +Y up, the right-hand
      // side of a heading is `tangent x up`, which is (-tz, 0, tx). Getting this
      // backwards mirrors the whole world -- the load ends up in the oncoming
      // lane and every sign is on the wrong shoulder -- so it is worth being
      // explicit about where it comes from. See LOCAL_RIGHT in Vehicle.js for
      // the same convention on the vehicle bodies.
      const lateral = new Vector3(-tangent.z, 0, tangent.x).normalize();
      this.samples.push({ s: acc, position: raw[i].clone(), tangent, lateral });
    }
    this.length = acc;
    this._spacing = this.length / (this.samples.length - 1);

    // Uniform bucket index over the XZ plane for fast nearest-sample queries.
    //
    // The key is packed into a single integer rather than formatted into a
    // string. Ground sampling drives this from the physics loop -- two dozen
    // wheels, two hundred times a second -- and a template literal there is tens
    // of thousands of short-lived strings a second for the collector to sweep up,
    // which is felt as a periodic hitch rather than as a lower frame rate.
    this.cell = 40;
    this.grid = new Map();
    for (let i = 0; i < this.samples.length; i++) {
      const p = this.samples[i].position;
      const cx = Math.floor(p.x / this.cell);
      const cz = Math.floor(p.z / this.cell);
      // Register in the sample's own cell and its neighbours so a lookup only
      // ever has to read one bucket.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = this.packKey(cx + dx, cz + dz);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          if (list[list.length - 1] !== i) list.push(i);
        }
      }
    }
  }

  /**
   * Packs a signed cell coordinate pair into one integer.
   *
   * The route spans a few thousand metres either way, so ±16384 cells of range
   * is far more than it can use and the product stays inside the exact-integer
   * range of a double.
   */
  packKey(cx, cz) {
    return (cx + 16384) * 32768 + (cz + 16384);
  }

  cellKey(x, z) {
    return this.packKey(Math.floor(x / this.cell), Math.floor(z / this.cell));
  }

  /**
   * Sample at arc length `s`, clamped to the route.
   *
   * Interpolated between the two bracketing samples rather than snapped to the
   * nearer one. The samples are five metres apart, and snapping means every
   * vehicle whose position comes from an arc length -- which is all the traffic,
   * all four escorts and every car on a cross street -- stands still for a
   * quarter of a second and then teleports five metres forward. It reads as the
   * whole road juddering, and no amount of smoothing further down can undo it
   * because the motion was never there to begin with.
   *
   * `out` is filled in place. Pass a scratch object to avoid allocating; the
   * default allocates, so a caller can hold the result across other calls.
   */
  at(s, out = {}) {
    const n = this.samples.length;
    const spacing = this._spacing;
    const f = Math.max(0, Math.min(n - 1, s / spacing));
    const i0 = Math.min(n - 1, Math.floor(f));
    const i1 = Math.min(n - 1, i0 + 1);
    const t = f - i0;

    const a = this.samples[i0];
    const b = this.samples[i1];

    out.position = out.position instanceof Vector3 ? out.position : new Vector3();
    out.tangent = out.tangent instanceof Vector3 ? out.tangent : new Vector3();
    out.lateral = out.lateral instanceof Vector3 ? out.lateral : new Vector3();

    out.position.lerpVectors(a.position, b.position, t);
    // Direction vectors are renormalised after the lerp: on a 5 m chord the
    // shortening is under a part in 10^5, but the tangent feeds every heading
    // on the route and an un-normalised one biases them all the same way.
    out.tangent.lerpVectors(a.tangent, b.tangent, t).normalize();
    out.lateral.lerpVectors(a.lateral, b.lateral, t).normalize();
    out.s = a.s + (b.s - a.s) * t;
    out.index = i0;
    return out;
  }

  /** Heading in radians at arc length `s`. */
  headingAt(s) {
    const { tangent } = this.at(s, this._scratchA);
    return Math.atan2(tangent.x, tangent.z);
  }

  /**
   * World position of a point on the route, offset laterally.
   * @param lateral metres right of the centreline
   */
  positionAt(s, lateral = 0, out = new Vector3()) {
    const sample = this.at(s, this._scratchA);
    out.copy(sample.position).addScaledVector(sample.lateral, lateral);
    return out;
  }

  // --- Cross-section -------------------------------------------------------
  // Thin delegates onto the corridor, so callers ask the route where the road
  // is rather than reaching through it.

  /** Metres from the centreline to the outside edge of the paved shoulder. */
  halfWidthAt(s) {
    return this.corridor.halfWidth(s);
  }

  /** Metres from the centreline to the outside edge line. */
  edgeOffsetAt(s) {
    return this.corridor.edgeOffset(s);
  }

  /** Lanes in one direction of travel. */
  laneCountAt(s) {
    return this.corridor.laneCount(s);
  }

  /**
   * Centre of a lane, metres right of the centreline. `index` counts outward
   * from the middle of the road: 0 is the inside lane, `laneCountAt - 1` the
   * kerb lane. `direction` is +1 with the convoy, -1 against it.
   */
  laneOffsetAt(s, direction, index) {
    return this.corridor.laneOffset(s, direction, index);
  }

  /**
   * The lane the permit routes the load down.
   *
   * The inside lane, always. On the two-lane sections that is the only lane
   * there is; through town it is the one against the centre turn lane, which
   * leaves the load with the emptiest thing on the road either side of it and
   * puts the kerb lane -- the one with the driveways, the parked cars and the
   * right turns on it -- on the far side of an escort rather than beside the
   * load.
   */
  convoyLaneOffset(s) {
    return this.corridor.laneOffset(s, 1, 0);
  }

  /** Width of the centre area between the two inside lanes. */
  medianAt(s) {
    return this.corridor.median(s);
  }

  /** Posted speed limit, mph. */
  speedLimitAt(s) {
    return this.corridor.limitMph(s);
  }

  /** What kind of road this is: rural, mountain, suburban or industrial. */
  kindAt(s) {
    return this.corridor.kind(s);
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
      for (let n = 0; n < candidates.length; n++) {
        const i = candidates[n];
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

    return this.finishProjection(x, z, best, bestD, out);
  }

  /**
   * Projects a point already known to lie near sample `hint`.
   *
   * The physics asks for the height at four points a metre either side of each
   * contact patch in order to get a surface normal by finite difference. Those
   * are all within a metre of a projection that has just been computed, so
   * re-entering the spatial index for each of them is work with a known answer:
   * scanning a handful of samples either side of the hint finds the same one for
   * a fraction of the cost. If the winner lands on the edge of the window the
   * hint was wrong and this falls back to the full query.
   */
  projectNear(x, z, hint, out = {}, window = 4) {
    if (!(hint >= 0)) return this.project(x, z, out);
    const lo = Math.max(0, hint - window);
    const hi = Math.min(this.samples.length - 1, hint + window);
    let best = -1;
    let bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const p = this.samples[i].position;
      const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if ((best === lo && lo > 0) || (best === hi && hi < this.samples.length - 1)) {
      return this.project(x, z, out);
    }
    return this.finishProjection(x, z, best, bestD, out);
  }

  /** Turns a winning sample index into the projection result. */
  finishProjection(x, z, best, bestD, out) {
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
    const camber = -Math.min(Math.abs(proj.lateral), this.halfWidthAt(proj.s)) * 0.02;
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

  /** The next signalised junction ahead of arc length `s`, or null. */
  nextSignal(s) {
    for (const j of this.junctions) if (j.s > s && j.signal) return j;
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
    const a = this.at(s - window / 2, this._scratchB);
    const b = this.at(s + window / 2, this._scratchC);
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
    // Never above the posted limit, which is the only number on this route the
    // load shares with everybody else on it.
    let mph = this.speedLimitAt(s);
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
