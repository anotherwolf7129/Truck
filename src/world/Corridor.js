/**
 * The road's cross-section, and how it changes along the route.
 *
 * A permit route is not one road. It leaves the port on a two-lane industrial
 * spur, works across the city on five-lane arterials with a centre turn lane and
 * a signal every quarter mile, goes up a single-lane ramp onto an interstate
 * three lanes wide behind a barrier, and comes off it again. The load has to be
 * routed down all of it, and almost everything the other vehicles do -- which
 * lane they sit in, whether they can get past the load at all, whether they have
 * to take the kerb or can simply move over one -- falls out of how many lanes
 * there are at that point.
 *
 * So the cross-section is a first-class part of the world rather than a pair of
 * constants. Sections are declared at arc lengths and blended across a taper, so
 * a lane opens up the way a real one does: the pavement widens first and the lane
 * is only usable once the taper is finished.
 */

/** Default length of the transition between two sections, metres. */
const TAPER = 80;

const smoothstep = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

export class Corridor {
  /**
   * @param sections  ordered by `s`, each { s, name, kind, lanes, median, shoulder, limitMph }
   *                  where `lanes` is lanes *per direction* and `median` is the
   *                  width of the centre area between the two inner lanes (0 for
   *                  a painted centreline, one lane wide for a centre turn lane).
   * @param laneWidth metres
   */
  constructor(sections, { laneWidth = 3.7 } = {}) {
    this.laneWidth = laneWidth;
    this.sections = sections.slice().sort((a, b) => a.s - b.s);

    // Reused so that a per-frame query for every vehicle on the road does not
    // allocate.
    this._out = {
      lanes: 1, median: 0, shoulder: 2.4, limitMph: 45,
      kind: 'urban', name: '', centre: 'double-yellow',
    };

    this.maxHalfWidth = 0;
    this.maxLanes = 1;
    for (const sec of this.sections) {
      this.maxHalfWidth = Math.max(
        this.maxHalfWidth,
        sec.median * 0.5 + sec.lanes * laneWidth + sec.shoulder
      );
      this.maxLanes = Math.max(this.maxLanes, sec.lanes);
    }
  }

  /** Index of the section covering `s`. */
  indexAt(s) {
    const list = this.sections;
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].s <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * The cross-section at `s`, blended through the taper either side of a
   * boundary.
   *
   * `lanes` comes back fractional inside a taper. That is deliberate: the paved
   * width follows it continuously, so the road widens into the extra lane
   * instead of gaining it in one step, while `laneCount` below stays integral
   * and only opens the lane once there is a full one to drive in.
   */
  at(s, out = this._out) {
    const i = this.indexAt(s);
    const cur = this.sections[i];

    // Both boundaries are considered, not just the nearer one. A section only a
    // couple of hundred metres long -- which is what turn widening is, a wider
    // shoulder either side of a corner -- has a taper running off each end, and
    // dropping the one behind you the moment the one ahead starts leaves a step
    // in the pavement edge where the two overlap.
    let prev = null;
    let tPrev = 0;
    if (i > 0) {
      const half = (cur.taper ?? TAPER) * 0.5;
      if (s < cur.s + half) {
        prev = this.sections[i - 1];
        tPrev = smoothstep((cur.s + half - s) / (half * 2));
      }
    }

    let next = null;
    let tNext = 0;
    const ahead = this.sections[i + 1];
    if (ahead) {
      const half = (ahead.taper ?? TAPER) * 0.5;
      if (s > ahead.s - half) {
        next = ahead;
        tNext = smoothstep((s - (ahead.s - half)) / (half * 2));
      }
    }

    const mix = (key) => {
      let v = cur[key];
      if (prev) v += (prev[key] - v) * tPrev;
      if (next) v += (next[key] - v) * tNext;
      return v;
    };
    out.lanes = mix('lanes');
    out.median = mix('median');
    out.shoulder = mix('shoulder');

    // Posted limits and the kind of place this is do not blend -- a sign either
    // applies or it does not. Whichever section the point is mostly in wins.
    let dominant = cur;
    if (tPrev > 0.5 && tPrev >= tNext) dominant = prev;
    else if (tNext > 0.5) dominant = next;
    out.limitMph = dominant.limitMph;
    out.kind = dominant.kind;
    out.name = dominant.name;
    // What is down the middle of the road. A painted centreline and a concrete
    // barrier are both "the median" as far as lane geometry is concerned, and
    // completely different things to look at or to swing a load across.
    out.centre = dominant.centre ?? (dominant.median >= 1 ? 'turn-lane' : 'double-yellow');
    return out;
  }

  /** Lanes in one direction of travel at `s`. Always at least one. */
  laneCount(s) {
    // Floored rather than rounded: a lane is only available once the taper that
    // opens it has finished, and a lane that is about to end stops being an
    // option as soon as its taper starts. Both are what the paint does.
    return Math.max(1, Math.floor(this.at(s).lanes + 1e-6));
  }

  /**
   * Centre of a lane, in metres right of the centreline.
   *
   * `index` counts outward from the centreline: 0 is the inside lane, the one
   * the load runs in, and `laneCount - 1` is the kerb lane.
   */
  laneOffset(s, direction, index) {
    const x = this.at(s);
    return direction * (x.median * 0.5 + (index + 0.5) * this.laneWidth);
  }

  /** Metres from the centreline to the outside edge line. */
  edgeOffset(s) {
    const x = this.at(s);
    return x.median * 0.5 + x.lanes * this.laneWidth;
  }

  /** Metres from the centreline to the outside edge of the paved shoulder. */
  halfWidth(s) {
    const x = this.at(s);
    return x.median * 0.5 + x.lanes * this.laneWidth + x.shoulder;
  }

  /** Width of the centre area between the two inside lanes. */
  median(s) {
    return this.at(s).median;
  }

  /** Posted speed limit, mph. */
  limitMph(s) {
    return this.at(s).limitMph;
  }

  /** 'industrial' | 'urban' | 'downtown' | 'ramp' | 'freeway' */
  kind(s) {
    return this.at(s).kind;
  }

  /** 'double-yellow' | 'turn-lane' | 'barrier' — what runs down the middle. */
  centre(s) {
    return this.at(s).centre;
  }

  /**
   * True where the road runs between buildings rather than past them.
   *
   * Kerbs, footways, street lighting, the graded shelf the whole place is built
   * on and how busy the road is all follow from this rather than from each
   * caller keeping its own list of which kinds count as town.
   */
  static isBuiltUp(kind) {
    return kind === 'urban' || kind === 'downtown' || kind === 'industrial';
  }

  /** Points where the posted limit changes, for signing the route. */
  limitChanges() {
    const out = [];
    for (let i = 0; i < this.sections.length; i++) {
      const prev = i > 0 ? this.sections[i - 1].limitMph : null;
      if (this.sections[i].limitMph !== prev) {
        out.push({ s: this.sections[i].s, limitMph: this.sections[i].limitMph });
      }
    }
    return out;
  }
}
