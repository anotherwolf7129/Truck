/**
 * The record of how a permit move actually went.
 *
 * A heavy haul job is not scored on time. It is scored on whether the load
 * arrived without anything happening to it, and the numbers that decide that are
 * the ones an escort crew and a permit officer would argue about afterwards:
 * how close the load came to going over, how hot the drums got on the descent,
 * whether the air survived, whether the rig ever left the surveyed corridor, and
 * whether every junction on the route was actually held.
 *
 * The same object drives the end-of-move debrief and the mission test, so the
 * score the player is shown is the score the test suite asserts on.
 */

/** Verdicts, worst first, so a run's overall grade is just the worst line. */
export const Verdict = { FAIL: 'fail', WARN: 'warn', PASS: 'pass' };

const RANK = { fail: 0, warn: 1, pass: 2 };

/** Picks a verdict from a value and two thresholds, for a lower-is-better metric. */
function below(value, passUnder, warnUnder) {
  if (value < passUnder) return Verdict.PASS;
  if (value < warnUnder) return Verdict.WARN;
  return Verdict.FAIL;
}

/** As above, for a higher-is-better metric. */
function above(value, passOver, warnOver) {
  if (value > passOver) return Verdict.PASS;
  if (value > warnOver) return Verdict.WARN;
  return Verdict.FAIL;
}

export class Scorecard {
  /**
   * @param route       the permitted route
   * @param loadHeight  overall height of the load above the road, metres
   */
  constructor(route, loadHeight) {
    this.route = route;
    this.loadHeight = loadHeight;

    this.outcome = null;          // null while running | 'delivered' | 'rolled'
    this.elapsed = 0;             // seconds on the road
    this.s = 0;                   // arc length reached
    // Where the scored run began. Captured on the first observation rather than
    // assumed to be zero, so distance and average speed stay honest when the
    // convoy has been teleported partway up the route.
    this.startS = null;

    this.peakRollover = 0;
    this.peakJackknife = 0;
    this.peakBrakeC = 0;
    this.peakClutchC = 0;
    this.overRevDamage = 0;
    this.minPsi = Infinity;
    this.maxOffRoute = 0;
    this.lowestClearanceMargin = Infinity;

    // A chassis strike is the well deck touching down. Counted as separate
    // events rather than frames, since one crest is one strike however long the
    // underside is in contact.
    this.chassisStrikes = 0;
    this._striking = false;

    this.junctionsBlocked = 0;
    this.junctionsMissed = [];
    this._seenJunctions = new Set();
  }

  /**
   * Folds one simulation step into the record.
   *
   * @param dt       timestep
   * @param rig      the combination
   * @param convoy   ConvoyManager, for the blockade states
   * @param s        arc length of the tractor along the route
   * @param lateral  signed metres from the centreline
   */
  observe(dt, rig, convoy, s, lateral) {
    if (this.outcome) return;

    this.elapsed += dt;
    this.s = s;
    if (this.startS === null) this.startS = s;

    const t = rig.telemetry;
    if (t.rollover > this.peakRollover) this.peakRollover = t.rollover;
    if (t.jackknife > this.peakJackknife) this.peakJackknife = t.jackknife;
    if (t.brakeTempC > this.peakBrakeC) this.peakBrakeC = t.brakeTempC;
    if (rig.air.psi < this.minPsi) this.minPsi = rig.air.psi;

    const clutchC = rig.powertrain.clutchTempC;
    if (clutchC > this.peakClutchC) this.peakClutchC = clutchC;
    this.overRevDamage = rig.powertrain.overRevDamage;

    const off = Math.abs(lateral);
    if (off > this.maxOffRoute) this.maxOffRoute = off;

    // Underside contact, counted on the leading edge only.
    const touching = rig.units.some((u) => u.chassisContact > 0);
    if (touching && !this._striking) this.chassisStrikes++;
    this._striking = touching;

    // A junction is judged the moment the load reaches it.
    for (const b of convoy.blockades) {
      if (this._seenJunctions.has(b.name) || s <= b.s - 5) continue;
      this._seenJunctions.add(b.name);
      if (b.active) this.junctionsBlocked++;
      else this.junctionsMissed.push(b.name);
    }

    // Clearance is only meaningful while actually under the structure.
    for (const bridge of this.route.bridges) {
      if (Math.abs(bridge.s - s) >= 12) continue;
      const margin = bridge.clearance - this.loadHeight;
      if (margin < this.lowestClearanceMargin) this.lowestClearanceMargin = margin;
    }
  }

  /**
   * Drops everything behind `s` from the record without penalty.
   *
   * The convoy can be teleported up the route to inspect a particular feature.
   * Without this, every junction jumped over is judged the instant the load
   * lands past it -- unheld, because no unit was ever sent -- and the card
   * reports a string of failures for road the player never drove.
   */
  skipTo(s) {
    for (const j of this.route.junctions) {
      if (j.s <= s) this._seenJunctions.add(j.name);
    }
    this.s = s;
    this.startS = s;
    return this;
  }

  /** Closes the record. `outcome` is 'delivered' or 'rolled'. */
  finish(outcome) {
    if (!this.outcome) this.outcome = outcome;
    return this;
  }

  get completed() {
    return this.outcome === 'delivered';
  }

  get minutes() {
    return this.elapsed / 60;
  }

  /** Distance actually driven, not position along the route. */
  get distanceMi() {
    return Math.max(0, this.s - (this.startS ?? 0)) / 1609.34;
  }

  /**
   * The plain data view, in the shape the mission test asserts against.
   */
  get report() {
    return {
      completed: this.completed,
      outcome: this.outcome,
      minutes: this.minutes,
      distanceMi: this.distanceMi,
      peakRollover: this.peakRollover,
      peakJackknife: this.peakJackknife,
      peakBrakeC: this.peakBrakeC,
      peakClutchC: this.peakClutchC,
      overRevDamage: this.overRevDamage,
      minPsi: this.minPsi === Infinity ? 0 : this.minPsi,
      maxOffRoute: this.maxOffRoute,
      lowestClearanceMargin: this.lowestClearanceMargin,
      chassisStrikes: this.chassisStrikes,
      junctionsBlocked: this.junctionsBlocked,
      junctionsMissed: this.junctionsMissed.slice(),
    };
  }

  /**
   * The scored lines, for the debrief.
   *
   * Thresholds sit inside the tolerances the mission test asserts, so a run the
   * tests would accept never reads as a failure on screen.
   */
  get lines() {
    const total = this.route.junctions.length;
    const out = [
      {
        label: 'Load stability',
        value: `${(this.peakRollover * 100).toFixed(0)}% of roll limit`,
        note: 'How close the load came to going over',
        verdict: below(this.peakRollover, 0.6, 0.85),
      },
      {
        label: 'Articulation',
        value: `${(this.peakJackknife * 100).toFixed(0)}% of jackknife`,
        note: 'Worst angle between tractor and jeep',
        verdict: below(this.peakJackknife, 0.5, 0.75),
      },
      {
        label: 'Brakes',
        value: `${this.peakBrakeC.toFixed(0)} °C peak`,
        note: 'Drum temperature on the descent',
        verdict: below(this.peakBrakeC, 250, 400),
      },
      {
        label: 'Air system',
        value: `${(this.minPsi === Infinity ? 0 : this.minPsi).toFixed(0)} psi low`,
        note: 'Spring brakes drop below 35 psi',
        verdict: above(this.minPsi, 90, 70),
      },
      {
        label: 'Corridor',
        value: `${this.maxOffRoute.toFixed(1)} m off centre`,
        note: 'The permit is for the surveyed corridor only',
        verdict: below(this.maxOffRoute, 4, 8),
      },
      {
        label: 'Junctions held',
        value: `${this.junctionsBlocked} of ${total}`,
        note: this.junctionsMissed.length
          ? `Missed: ${this.junctionsMissed.join(', ')}`
          : 'Every side road blocked before the load arrived',
        verdict: this.junctionsMissed.length ? Verdict.FAIL : Verdict.PASS,
      },
      {
        label: 'Deck clearance',
        value: this.chassisStrikes === 0
          ? 'no contact'
          : `${this.chassisStrikes} strike${this.chassisStrikes === 1 ? '' : 's'}`,
        note: 'The well deck grounding out on a crest',
        verdict: below(this.chassisStrikes, 1, 4),
      },
      {
        label: 'Clutch',
        value: `${this.peakClutchC.toFixed(0)} °C peak`,
        note: 'Launching in too tall a gear cooks it',
        verdict: below(this.peakClutchC, 200, 320),
      },
    ];

    // Only worth reporting if a bridge was actually passed under.
    if (this.lowestClearanceMargin !== Infinity) {
      out.push({
        label: 'Tightest bridge',
        value: `${(this.lowestClearanceMargin * 100).toFixed(0)} cm over the load`,
        note: 'Measured at the tightest structure on the route',
        verdict: this.lowestClearanceMargin < 0
          ? Verdict.FAIL
          : this.lowestClearanceMargin < 0.15 ? Verdict.WARN : Verdict.PASS,
      });
    }

    return out;
  }

  /** The worst line on the card, which is the grade for the whole move. */
  get grade() {
    if (this.outcome === 'rolled') return Verdict.FAIL;
    let worst = Verdict.PASS;
    for (const line of this.lines) {
      if (RANK[line.verdict] < RANK[worst]) worst = line.verdict;
    }
    return worst;
  }

  /** What dispatch would say about it. */
  get verdictText() {
    if (this.outcome === 'rolled') {
      return 'The load went over. That is a crane, a road closure and an insurance claim.';
    }
    switch (this.grade) {
      case Verdict.PASS:
        return 'Clean move. The load never came close to anything, and nobody on the route had to think about it.';
      case Verdict.WARN:
        return 'Delivered, and nothing was damaged — but there are a couple of things on this sheet you got away with rather than got right.';
      default:
        return 'Delivered, but not well. Any one of the flagged items below ends the job on a different day.';
    }
  }
}
