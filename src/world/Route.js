import { Vector3, CatmullRomCurve3 } from 'three';
import { Corridor } from './Corridor.js';
import { SignalNetwork } from './Signal.js';
import { Survey } from './Survey.js';

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
 *
 * This one runs across a city, which is a different job from running one down a
 * county highway. The load does not simply follow a road: it turns off one
 * arterial onto another at signalised intersections, six times, and each of
 * those turns is a corner taken at walking pace across every lane of the
 * junction with a unit holding the light. Between them it goes up onto an
 * interstate at a loop ramp, runs the freeway with the traffic, and comes off
 * again at an exit. Almost everything below follows from that: the number of
 * lanes, what runs down the middle of the road, where the pavement widens, and
 * why the escort work is lights rather than roadblocks for most of the move.
 */
export class Route {
  constructor() {
    const survey = this.buildSurvey();
    this.survey = survey;

    this.curve = new CatmullRomCurve3(survey.points, false, 'centripetal', 0.5);

    this.laneWidth = 3.7;
    this.shoulderWidth = 2.4;

    // Where each named place on the route is, taken from the survey rather than
    // written down twice. Move a corner and everything on it moves with it.
    const at = (name) => survey.at(name);

    // --- Cross-section ------------------------------------------------------
    // Seven different roads. It leaves the port on an industrial spur, turns onto
    // a dock arterial, works across the city on two boulevards and a downtown
    // street, climbs over Prospect Hill, goes up a loop ramp onto the interstate,
    // comes off at an exit onto another arterial, and finishes on the industrial
    // road out to Northgate. Nearly everything the other vehicles on the road do
    // follows from which of those they are currently on.
    //
    // Every turn carries extra shoulder through the intersection. That is not
    // decoration: a combination between 64 and 249 feet long swinging through a
    // sixty-metre radius puts its rear axles well inside the tractor's path, and
    // the widening is the pavement that has to be there for the trailer to track
    // across. It is why the units close the whole junction rather than one arm
    // of it.
    this.corridor = new Corridor([
      { s: 0, name: 'Terminal Way', kind: 'industrial', lanes: 1, median: 0, shoulder: 2.8, limitMph: 25 },
      // Out of the port gate and round onto the dock arterial.
      { s: at('onto Dock Street') - 70, name: 'Terminal Way', kind: 'industrial', lanes: 1, median: 0, shoulder: 7.4, limitMph: 25, taper: 150 },
      { s: at('onto Dock Street') + 170, name: 'Dock Street', kind: 'urban', lanes: 2, median: 3.7, shoulder: 1.8, limitMph: 30, taper: 150 },

      { s: at('onto Harbor Boulevard') - 70, name: 'Dock Street', kind: 'urban', lanes: 2, median: 3.7, shoulder: 6.4, limitMph: 30, taper: 150 },
      { s: at('onto Harbor Boulevard') + 180, name: 'Harbor Boulevard', kind: 'urban', lanes: 2, median: 4.2, shoulder: 2.0, limitMph: 35, taper: 150 },

      { s: at('onto Market Street') - 70, name: 'Harbor Boulevard', kind: 'urban', lanes: 2, median: 4.2, shoulder: 6.4, limitMph: 30, taper: 150 },
      // Downtown: the same two lanes each way, but a narrower turn lane, kerbs
      // hard against the running lane and a 25 sign.
      { s: at('onto Market Street') + 170, name: 'Market Street', kind: 'downtown', lanes: 2, median: 3.4, shoulder: 1.2, limitMph: 25, taper: 190 },

      { s: at('onto Prospect Hill') - 70, name: 'Market Street', kind: 'downtown', lanes: 2, median: 3.4, shoulder: 6.4, limitMph: 25, taper: 150 },
      // Over the hill: one lane each way and a double yellow, which is the one
      // stretch in the city where oncoming traffic has nowhere to go but the
      // kerb — and it is also the nine percent.
      { s: at('onto Prospect Hill') + 180, name: 'Prospect Hill Road', kind: 'urban', lanes: 1, median: 0, shoulder: 1.6, limitMph: 30, taper: 320 },

      // The loop ramp: one lane, a 25 sign on the curve, and the widest shoulder
      // on the route because it is the tightest corner on it.
      { s: at('ramp') - 80, name: 'I-118 north on-ramp', kind: 'ramp', lanes: 1, median: 0, shoulder: 5.6, limitMph: 25, taper: 140 },
      { s: at('ramp') + 150, name: 'I-118 north on-ramp', kind: 'ramp', lanes: 1, median: 0, shoulder: 2.8, limitMph: 35, taper: 140 },
      // Three lanes each way behind a barrier. The pavement reaches freeway
      // width over the length of the acceleration lane while there is still only
      // one lane to drive in, which is what a merge is.
      { s: at('merge'), name: 'Interstate 118', kind: 'freeway', lanes: 3, median: 4.4, shoulder: 3.2, limitMph: 55, centre: 'barrier', taper: 320 },
      { s: at('exit'), name: 'I-118 exit 14', kind: 'ramp', lanes: 1, median: 0, shoulder: 4.0, limitMph: 35, taper: 300 },

      { s: at('Meridian settled'), name: 'Meridian Avenue', kind: 'urban', lanes: 2, median: 3.7, shoulder: 1.8, limitMph: 35, taper: 160 },
      { s: at('onto Foundry Road') - 70, name: 'Meridian Avenue', kind: 'urban', lanes: 2, median: 3.7, shoulder: 6.4, limitMph: 30, taper: 150 },
      { s: at('onto Foundry Road') + 170, name: 'Foundry Road', kind: 'industrial', lanes: 1, median: 0, shoulder: 2.6, limitMph: 30, taper: 320 },

      { s: at('substation turn') - 60, name: 'Northgate gate', kind: 'industrial', lanes: 1, median: 0, shoulder: 6.0, limitMph: 25, taper: 150 },
      { s: at('substation turn') + 150, name: 'Northgate yard', kind: 'industrial', lanes: 1, median: 0, shoulder: 3.2, limitMph: 20, taper: 150 },
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
    // Six of these are intersections the load turns at, which is the whole
    // difference between escorting a move across a city and down a highway. The
    // unit does not just hold the cross street: it takes the light, stops every
    // approach including the one behind the load, and the combination swings
    // through the box using all of it.
    this.junctions = [
      { s: at('onto Dock Street'), name: 'Terminal & Dock', side: -1, signal: true, crossing: true, turn: 'left' },
      { s: at('Pier 9 Road'), name: 'Pier 9 Road', side: 1 },
      { s: at('Cannery Street'), name: 'Cannery Street', side: -1, signal: true, crossing: true },
      { s: at('onto Harbor Boulevard'), name: 'Dock & Harbor', side: 1, signal: true, crossing: true, turn: 'right' },
      { s: at('Rail Yard Road'), name: 'Rail Yard Road', side: -1 },
      { s: at('Wharf Street'), name: 'Wharf Street', side: 1, signal: true, crossing: true },
      { s: at('onto Market Street'), name: 'Harbor & Market', side: -1, signal: true, crossing: true, turn: 'left' },
      // --- Downtown ---------------------------------------------------------
      { s: at('Third Street'), name: 'Third Street', side: 1, signal: true, crossing: true },
      { s: at('Exchange Place'), name: 'Exchange Place', side: -1 },
      { s: at('onto Prospect Hill'), name: 'Market & Prospect', side: 1, signal: true, crossing: true, turn: 'right' },
      // --- Over the hill and onto the interstate -----------------------------
      { s: at('Prospect & Canal'), name: 'Prospect & Canal', side: -1, signal: true, crossing: true },
      // --- Off the freeway and out to Northgate ------------------------------
      { s: at('Meridian & Canal'), name: 'Meridian & Canal', side: 1, signal: true, crossing: true },
      { s: at('Tanner Street'), name: 'Tanner Street', side: -1 },
      { s: at('onto Foundry Road'), name: 'Meridian & Foundry', side: 1, signal: true, crossing: true, turn: 'right' },
      { s: at('Kiln Street'), name: 'Kiln Street', side: -1 },
      { s: at('Substation Access'), name: 'Substation Access', side: 1 },
    ];

    // The signal controllers. They live on the route because both the escorts
    // and the ambient traffic have to read the same lights; the convoy manager
    // is what ticks them, since holding a light is escort work.
    this.signals = new SignalNetwork(this);

    // Posted vertical clearances. The lead pilot car carries a height pole set
    // just above the load; if the pole hits, the load would have hit.
    this.bridges = [
      { s: at('Beacon Hill viaduct'), name: 'Beacon Hill viaduct', clearance: 5.36, span: 20 },
      { s: at('Canal Street overpass'), name: 'Canal Street overpass', clearance: 5.28, span: 26 },
      { s: at('Junction 14 overpass'), name: 'Junction 14 overpass', clearance: 5.14, span: 30 },
      // The last structure on the route and the tightest: a low rail bridge over
      // an industrial street, which is the one every permit on this route is
      // written around.
      { s: at('Northgate underpass'), name: 'Northgate rail underpass', clearance: 5.05, span: 16 },
    ];

    // The corners the survey flagged: an intersection the load turns at is a
    // corner taken at walking pace across every lane of the junction, and the
    // trailer's rear axles have to be steered through all of them. The loop ramp
    // onto the interstate is the tightest thing on the route.
    this.tightCorners = [
      { s: at('onto Dock Street'), name: 'Terminal & Dock left', advisoryMph: 8, radius: 65 },
      { s: at('onto Harbor Boulevard'), name: 'Dock & Harbor right', advisoryMph: 8, radius: 72 },
      { s: at('onto Market Street'), name: 'Harbor & Market left', advisoryMph: 7, radius: 60 },
      { s: at('onto Prospect Hill'), name: 'Market & Prospect right', advisoryMph: 7, radius: 62 },
      { s: at('ramp'), name: 'I-118 loop ramp', advisoryMph: 7, radius: 58 },
      { s: at('off ramp'), name: 'Exit 14 ramp', advisoryMph: 9, radius: 68 },
      { s: at('onto Foundry Road'), name: 'Meridian & Foundry right', advisoryMph: 8, radius: 66 },
      { s: at('substation turn'), name: 'Northgate gate', advisoryMph: 7, radius: 55 },
    ];

    // Prospect Hill. Nine percent for half a mile down into the canal district,
    // with a signalised junction at the bottom of it -- which is why a unit has
    // to have that light, and why running it is the one thing on this route that
    // can stop the load somewhere it cannot start again.
    this.grades = [
      { start: at('grade top'), end: at('grade bottom'), name: 'Prospect Hill', percent: -9 },
    ];

    // The signs that tell the driver something the road does not: where the
    // interstate goes and which exit comes off it.
    this.guideSigns = [
      { s: at('ramp') - 230, text: 'I-118 NORTH\nRamp 25 MPH', side: 1 },
      { s: at('merge') - 60, text: 'MERGE\nAcceleration lane ends', side: 1 },
      { s: at('exit') - 640, text: 'EXIT 14\nMeridian Ave  ¾ MILE', side: 1 },
      { s: at('exit') - 60, text: 'EXIT 14\nMeridian Ave', side: 1 },
      { s: at('onto Foundry Road') - 300, text: 'FOUNDRY RD\nNorthgate  ½ MILE', side: 1 },
    ];

    this.staging = { s: 60, name: 'Anchor Point Terminal' };
    this.destination = { s: at('substation'), name: 'Northgate Substation' };
  }

  /**
   * The survey the centreline is built from.
   *
   * Read it as a driver would be told it: out of the terminal, left at the
   * lights onto Dock Street, right onto Harbor Boulevard, left into downtown,
   * right up over Prospect Hill, down the nine percent, up the loop ramp onto
   * I-118, off at exit 14, and right onto Foundry Road for Northgate. Every
   * corner has a stated radius, and every place anything happens is marked, so
   * the junctions, the bridges, the grade and the cross-section are all placed
   * from the same description rather than from a second list of numbers that has
   * to be kept in step with it.
   *
   * The turn radii are the one place this route argues with reality. A city
   * intersection is built to a kerb radius of fifteen metres, which nothing on
   * this list can drive round; what actually happens on a move like this is that
   * the units stop every approach and the combination uses the whole box and
   * both carriageways of the road it is turning into. Sixty metres on the
   * centreline is what that manoeuvre traces out, and the pavement is widened
   * through each junction to match.
   */
  buildSurvey() {
    const s = new Survey({ x: 0, z: 0, y: 6, heading: 0 });

    // --- Out of Anchor Point Terminal --------------------------------------
    s.run(300, 0.002);
    s.mark('onto Dock Street');
    s.left(88, 65, 0.002);                 // first light: left onto Dock Street
    s.run(200, 0.004);

    // --- Dock Street, along the waterfront ---------------------------------
    s.mark('Pier 9 Road');
    s.run(300, 0.005);
    s.mark('Cannery Street');
    s.run(340, 0.006);
    s.weave(14, 340, 0.006);
    s.run(260, 0.008);
    s.mark('onto Harbor Boulevard');
    s.right(94, 72, 0.006);                // right at the light onto the boulevard
    s.run(240, 0.01);

    // --- Harbor Boulevard, climbing away from the water --------------------
    s.mark('Rail Yard Road');
    s.run(320, 0.012);
    s.left(16, 420, 0.014);
    s.run(240, 0.016);
    s.mark('Wharf Street');
    s.run(300, 0.018);
    s.mark('Beacon Hill viaduct');         // the city's own elevated line, over the road
    s.run(280, 0.02);
    s.mark('onto Market Street');
    s.left(86, 60, 0.018);                 // left at the light, into downtown
    s.run(220, 0.024);

    // --- Market Street, downtown -------------------------------------------
    s.mark('Third Street');
    s.run(300, 0.03);
    s.right(14, 380, 0.032);
    s.run(260, 0.034);
    s.mark('Exchange Place');
    s.run(300, 0.038);
    s.mark('onto Prospect Hill');
    s.right(82, 62, 0.04);                 // right at the light, onto the hill road
    s.run(200, 0.06);

    // --- Prospect Hill ------------------------------------------------------
    s.run(320, 0.075);
    s.left(30, 220, 0.06);
    s.run(160, 0.03);
    s.mark('grade top');

    // --- The nine percent, down into the canal district ---------------------
    s.right(26, 200, -0.07);
    s.run(320, -0.09);
    s.left(32, 240, -0.09);
    s.run(360, -0.09);
    s.right(22, 280, -0.088);
    s.run(220, -0.08);
    s.mark('grade bottom');
    s.run(160, -0.04);
    s.mark('Prospect & Canal');             // a light at the bottom of the grade
    s.run(220, -0.012);

    // --- Up the loop ramp onto Interstate 118 -------------------------------
    s.mark('ramp');
    s.right(98, 58, 0.02);                  // the tightest corner on the route
    s.run(200, 0.024);
    s.mark('merge');                        // the acceleration lane runs out here
    s.run(360, 0.012);
    s.mark('Canal Street overpass');
    s.run(420, 0.004);
    s.left(20, 720, 0);
    s.run(480, -0.002);
    s.mark('Junction 14 overpass');
    s.run(440, -0.004);
    s.right(16, 800, -0.004);
    s.run(400, -0.006);

    // --- Off at exit 14 ------------------------------------------------------
    s.mark('exit');
    s.run(260, -0.01);                      // deceleration lane
    s.mark('off ramp');
    s.right(76, 68, -0.016);
    s.run(180, -0.014);

    // --- Meridian Avenue -----------------------------------------------------
    s.mark('Meridian settled');
    s.run(240, -0.008);
    s.mark('Meridian & Canal');
    s.run(320, -0.004);
    s.weave(16, 380, -0.002);
    s.run(280, 0);
    s.mark('Tanner Street');
    s.run(320, 0);
    s.mark('onto Foundry Road');
    s.right(88, 66, 0);                     // right at the light onto Foundry Road
    s.run(240, 0);

    // --- Foundry Road, out to Northgate --------------------------------------
    s.mark('Kiln Street');
    s.run(300, -0.004);
    s.mark('Northgate underpass');          // the low one
    s.run(280, -0.004);
    s.mark('Substation Access');
    s.run(200, -0.002);

    // --- In at the gate ------------------------------------------------------
    s.mark('substation turn');
    s.right(86, 55, -0.004);
    s.run(260, -0.004);
    s.mark('substation');
    s.run(180, 0);                          // yard beyond the delivery point

    return s;
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

  /** What kind of road this is: industrial, urban, downtown, ramp or freeway. */
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
   * Signed curvature at arc length `s`, 1/metres. Positive turns **left**.
   *
   * The sign is what lets an AI driver point its front wheels the way the road
   * actually goes instead of tracking the centreline with the wheels straight,
   * and it is a rotation about +Y like every other angle in this project -- so
   * positive is counter-clockwise seen from above, which is a left turn. See the
   * note on LOCAL_RIGHT in physics/Vehicle.js.
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
    // A flagged corner applies from well before it. The station is where the
    // turn starts, the corner itself runs a hundred metres and more past that at
    // these radii, and you have to be down to the number before you are in it --
    // a 212,000 lb load does not lose twenty miles an hour on the entry.
    for (const c of this.tightCorners) {
      if (s > c.s - 120 && s < c.s + 240) mph = Math.min(mph, c.advisoryMph);
    }
    const grade = this.gradeAt(s);
    if (grade < -0.04) mph = Math.min(mph, 25);
    return Math.max(5, mph);
  }
}
