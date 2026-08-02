/**
 * The road's cross-section, and how it changes along the route.
 *
 * A permit route is not one road. It starts as a two-lane county highway, climbs
 * a ridge on something narrower than that, and comes into town as a five-lane
 * suburban arterial with a centre turn lane and a signal every quarter mile. The
 * load has to be routed down all of it, and almost everything the other vehicles
 * do -- which lane they sit in, whether they can get past the load at all,
 * whether they have to take the shoulder or can simply move over one -- falls out
 * of how many lanes there are at that point.
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
    this._out = { lanes: 1, median: 0, shoulder: 2.4, limitMph: 45, kind: 'rural', name: '' };

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

    let other = null;
    let t = 0;

    const next = this.sections[i + 1];
    if (next) {
      const half = (next.taper ?? TAPER) * 0.5;
      if (s > next.s - half) {
        other = next;
        t = smoothstep((s - (next.s - half)) / (half * 2));
      }
    }
    if (!other && i > 0) {
      const half = (cur.taper ?? TAPER) * 0.5;
      if (s < cur.s + half) {
        other = this.sections[i - 1];
        t = smoothstep((cur.s + half - s) / (half * 2));
      }
    }

    const mix = (key) => (other ? cur[key] + (other[key] - cur[key]) * t : cur[key]);
    out.lanes = mix('lanes');
    out.median = mix('median');
    out.shoulder = mix('shoulder');

    // Posted limits and the kind of place this is do not blend -- a sign either
    // applies or it does not. Whichever section the point is mostly in wins.
    const dominant = other && t > 0.5 ? other : cur;
    out.limitMph = dominant.limitMph;
    out.kind = dominant.kind;
    out.name = dominant.name;
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

  /** 'rural' | 'mountain' | 'suburban' | 'industrial' */
  kind(s) {
    return this.at(s).kind;
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
