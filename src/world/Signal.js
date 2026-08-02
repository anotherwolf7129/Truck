/**
 * Traffic signals.
 *
 * A signalised intersection changes the escort job completely. At a side road
 * with a stop sign the officer has to physically put the car across the mouth of
 * it, which means crossing the carriageway and shutting the highway down for the
 * few seconds that takes. At a signal he does not: he takes the light, holds the
 * mainline green and every other approach red, and the whole intersection is his
 * without anybody driving across the road. That is why a suburban arterial full
 * of lights is quicker to escort than a country road full of farm lanes, and it
 * is the difference this class exists to express.
 */

export const Phase = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };

export class TrafficSignal {
  /**
   * @param junction  the junction this signal controls
   * @param timing    { mainGreen, cross, yellow, allRed } seconds
   */
  constructor(junction, {
    mainGreen = 34, crossGreen = 15, yellow = 4, allRed = 2, offset = null,
  } = {}) {
    this.junction = junction;
    this.s = junction.s;
    this.name = junction.name;

    this.mainGreen = mainGreen;
    this.crossGreen = crossGreen;
    this.yellow = yellow;
    this.allRed = allRed;

    this.cycle = mainGreen + crossGreen + 2 * (yellow + allRed);
    // Signals on an arterial are not synchronised here, so each one starts
    // somewhere else in its cycle and the drive through town is not a metronome.
    this.t = offset ?? Math.random() * this.cycle;

    // An escort holding the light. While preempted the controller freezes at the
    // top of the mainline green, which is what a preemption actually does.
    this.preempted = false;
    this.preemptedBy = null;
  }

  update(dt) {
    if (this.preempted) return;
    this.t = (this.t + dt) % this.cycle;
  }

  /**
   * Hands the signal to an escort, or gives it back.
   *
   * Coming out of a preemption the controller restarts its cycle rather than
   * resuming where it froze, so the cross street gets a full mainline green
   * before its turn rather than one second of one.
   */
  preempt(unit) {
    if (!this.preempted) this.t = 0;
    this.preempted = true;
    this.preemptedBy = unit ?? null;
  }

  release() {
    if (this.preempted) this.t = 0;
    this.preempted = false;
    this.preemptedBy = null;
  }

  /** Phase shown to traffic on the highway. */
  get mainline() {
    if (this.preempted) return Phase.GREEN;
    const t = this.t;
    if (t < this.mainGreen) return Phase.GREEN;
    if (t < this.mainGreen + this.yellow) return Phase.YELLOW;
    return Phase.RED;
  }

  /** Phase shown to traffic on the cross street. */
  get cross() {
    if (this.preempted) return Phase.RED;
    const t = this.t;
    const crossStart = this.mainGreen + this.yellow + this.allRed;
    if (t < crossStart) return Phase.RED;
    if (t < crossStart + this.crossGreen) return Phase.GREEN;
    if (t < crossStart + this.crossGreen + this.yellow) return Phase.YELLOW;
    return Phase.RED;
  }

  /** Seconds until the mainline loses its green, or Infinity while preempted. */
  get mainlineGreenLeft() {
    if (this.preempted) return Infinity;
    if (this.mainline !== Phase.GREEN) return 0;
    return this.mainGreen - this.t;
  }

  /** Seconds until the mainline gets its green back, 0 if it already has it. */
  get mainlineRedLeft() {
    if (this.preempted || this.mainline === Phase.GREEN) return 0;
    return this.cycle - this.t;
  }

  /** Seconds the cross street has left to clear the intersection. */
  get crossGreenLeft() {
    if (this.cross !== Phase.GREEN) return 0;
    const crossStart = this.mainGreen + this.yellow + this.allRed;
    return crossStart + this.crossGreen - this.t;
  }
}

/**
 * Every signal on the route, ticked together.
 *
 * Only signals near the convoy are worth updating -- a light four miles back is
 * not being looked at by anything -- but the cost of running all of them for a
 * dozen intersections is nothing, and keeping them all live means a signal is
 * never caught mid-cycle when the convoy arrives.
 */
export class SignalNetwork {
  constructor(route, options = {}) {
    this.route = route;
    this.signals = route.junctions
      .filter((j) => j.signal)
      .map((j) => new TrafficSignal(j, options));
    this.byJunction = new Map(this.signals.map((sig) => [sig.junction, sig]));
  }

  update(dt) {
    for (const sig of this.signals) sig.update(dt);
  }

  for(junction) {
    return this.byJunction.get(junction) ?? null;
  }

  /** The next signal ahead of `s` in the given direction of travel. */
  next(s, direction = 1) {
    let best = null;
    let bestGap = Infinity;
    for (const sig of this.signals) {
      const ahead = (sig.s - s) * direction;
      if (ahead <= 0 || ahead >= bestGap) continue;
      bestGap = ahead;
      best = sig;
    }
    return best;
  }

  reset() {
    for (const sig of this.signals) {
      sig.release();
      sig.t = Math.random() * sig.cycle;
    }
  }
}
