/**
 * Procedural audio for the rig and the convoy.
 *
 * Every sound here is synthesised from the simulation's own state -- there are
 * no samples, the same way there are no modelled meshes. That constraint is
 * actually a good fit for a diesel: the engine note *is* a firing frequency and
 * a set of harmonics, so driving it from rpm gives a note that lugs, revs and
 * shifts for free rather than one that has to be crossfaded between clips.
 *
 * Nothing in here assumes a browser. With no AudioContext the whole class is
 * inert, so the headless tests and tools can construct a game without one.
 */

// A four-stroke six fires three times per revolution, so the fundamental of the
// exhaust note is rpm/20 Hz -- about 30 Hz at idle and 105 Hz at the governor.
const FIRINGS_PER_REV = 3;

/** Builds a couple of seconds of white noise to loop as a source. */
function noiseBuffer(ctx) {
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export class AudioEngine {
  /**
   * Builds an engine if the browser will give us a context.
   *
   * Must be called from a user gesture -- autoplay policy will otherwise hand
   * back a context stuck in `suspended` and nothing will ever be heard.
   */
  static create() {
    const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctx) return new AudioEngine(null);
    try {
      return new AudioEngine(new Ctx());
    } catch {
      return new AudioEngine(null);
    }
  }

  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = !!ctx;
    this.muted = AudioEngine.loadMuted();
    this.suspended = false;

    // Edge detection for the one-shot sounds.
    this._lastParkingBrake = null;
    this._lastGear = null;
    this._lastPsi = 120;

    if (!this.enabled) return;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    this.master.connect(ctx.destination);

    // A little compression keeps the jake brake from burying everything else.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    comp.connect(this.master);
    this.bus = comp;

    this.noise = noiseBuffer(ctx);
    this.buildEngine();
    this.buildTurbo();
    this.buildJake();
    this.buildScrub();
    this.buildRoad();
  }

  // ---------------------------------------------------------------------------
  // Graph construction
  // ---------------------------------------------------------------------------

  /** A looping white-noise source. Each caller gets its own so it can be gated. */
  noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start();
    return src;
  }

  /**
   * The exhaust note: a fundamental at the firing frequency plus two harmonics
   * and a half-order rumble, behind a lowpass that opens up under load.
   *
   * The half-order component is what makes it read as a big slow-turning diesel
   * rather than a generic engine -- it is the beat you hear from a truck idling
   * two streets away.
   */
  buildEngine() {
    const ctx = this.ctx;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 0.9;

    this.engineOscs = [];
    // [frequency multiple, relative level, waveform]
    for (const [mult, level, type] of [
      [0.5, 0.55, 'sine'],
      [1.0, 1.00, 'sawtooth'],
      [2.0, 0.42, 'square'],
      [3.0, 0.18, 'sawtooth'],
    ]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      const gain = ctx.createGain();
      gain.gain.value = level;
      osc.connect(gain).connect(this.engineFilter);
      osc.start();
      this.engineOscs.push({ osc, mult });
    }

    this.engineFilter.connect(this.engineGain).connect(this.bus);
  }

  /** Turbo whistle: narrow resonant noise that rises and falls with boost. */
  buildTurbo() {
    const ctx = this.ctx;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;

    this.turboFilter = ctx.createBiquadFilter();
    this.turboFilter.type = 'bandpass';
    this.turboFilter.frequency.value = 3000;
    this.turboFilter.Q.value = 14;

    this.noiseSource().connect(this.turboFilter);
    this.turboFilter.connect(this.turboGain).connect(this.bus);
  }

  /**
   * The compression brake.
   *
   * A jake is the exhaust valve dumping a cylinder's worth of compressed air
   * once per firing event, so it is a pulse train at the same frequency as the
   * exhaust note -- hence the machine-gun bark. Amplitude-modulating noise with
   * a square wave at that frequency gets remarkably close.
   */
  buildJake() {
    const ctx = this.ctx;
    this.jakeGain = ctx.createGain();
    this.jakeGain.gain.value = 0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 1.4;

    // Square-wave modulator driving the depth of a noise gate.
    this.jakePulse = ctx.createOscillator();
    this.jakePulse.type = 'square';
    this.jakePulse.frequency.value = 40;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    const modulated = ctx.createGain();
    modulated.gain.value = 0.5;
    this.jakePulse.connect(depth).connect(modulated.gain);
    this.jakePulse.start();

    this.noiseSource().connect(filter).connect(modulated);
    modulated.connect(this.jakeGain).connect(this.bus);
  }

  /** Tire scrub, gated on how hard the tires are actually working. */
  buildScrub() {
    const ctx = this.ctx;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 2.2;

    this.noiseSource().connect(filter).connect(this.scrubGain).connect(this.bus);
  }

  /** Road and wind bed, scaled by speed. */
  buildRoad() {
    const ctx = this.ctx;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;

    this.roadFilter = ctx.createBiquadFilter();
    this.roadFilter.type = 'lowpass';
    this.roadFilter.frequency.value = 500;

    this.noiseSource().connect(this.roadFilter).connect(this.roadGain).connect(this.bus);
  }

  // ---------------------------------------------------------------------------
  // One-shots
  // ---------------------------------------------------------------------------

  /**
   * A burst of filtered noise -- the air system's whole vocabulary.
   * @param level  peak gain
   * @param decay  seconds to fall away
   * @param freq   centre of the band
   */
  hiss(level, decay, freq = 1800, Q = 1.2) {
    if (!this.enabled || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = Q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    src.connect(filter).connect(gain).connect(this.bus);
    src.start(now);
    src.stop(now + decay + 0.05);
  }

  /** Radio click before a voice call, pitched by how urgent the call is. */
  chirp(priority = 'normal') {
    if (!this.enabled || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const freq = priority === 'critical' ? 1500 : priority === 'warning' ? 1150 : 900;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

    osc.connect(gain).connect(this.bus);
    osc.start(now);
    osc.stop(now + 0.14);

    // The squelch tail that follows a real radio key-up.
    this.hiss(0.02, 0.09, 2600, 0.8);
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  /**
   * Drives the whole graph from the rig's state.
   *
   * Every parameter moves with `setTargetAtTime` rather than being assigned:
   * stepping an AudioParam once a frame is audible as zipper noise, and the
   * engine note in particular has to glide between frames to sound like an
   * engine rather than an arpeggio.
   */
  update(dt, rig) {
    if (!this.enabled || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const pt = rig.powertrain;

    const set = (param, value, tau = 0.05) => {
      param.setTargetAtTime(value, now, tau);
    };

    // --- Engine -------------------------------------------------------------
    const fundamental = Math.max(12, (pt.rpm / 60) * FIRINGS_PER_REV);
    for (const { osc, mult } of this.engineOscs) {
      set(osc.frequency, fundamental * mult, 0.03);
    }

    const load = Math.min(1, pt.throttle * 0.7 + pt.boost * 0.5);
    // Under load the exhaust gets harder and brighter; off throttle it closes up.
    set(this.engineFilter.frequency, 320 + load * 2400 + fundamental * 3, 0.05);
    // Idle is audible but the note only really arrives with fuel.
    const engineLevel = pt.neutral && pt.throttle < 0.05 ? 0.05 : 0.055 + load * 0.14;
    set(this.engineGain.gain, engineLevel, 0.06);

    // --- Turbo --------------------------------------------------------------
    set(this.turboFilter.frequency, 1800 + pt.boost * 4200, 0.08);
    // Spool is only audible when the engine is actually pulling.
    set(this.turboGain.gain, pt.boost * pt.boost * 0.035 * Math.min(1, pt.rpm / 1200), 0.08);

    // --- Compression brake --------------------------------------------------
    const jakeOn = pt.engineBrakeStage > 0 && pt.throttle < 0.05 && pt.rpm > 900;
    set(this.jakePulse.frequency, fundamental, 0.03);
    const jakeLevel = jakeOn ? 0.05 + pt.engineBrakeStage * 0.045 : 0;
    set(this.jakeGain.gain, jakeLevel, jakeOn ? 0.04 : 0.12);

    // --- Tire scrub ---------------------------------------------------------
    let saturation = 0;
    let slipping = 0;
    for (const unit of rig.units) {
      for (const w of unit.wheels) {
        if (!w.grounded) continue;
        if (w.saturation > saturation) saturation = w.saturation;
        slipping = Math.max(slipping, Math.min(1, Math.abs(w.slipRatio)));
      }
    }
    const speed = Math.abs(rig.speedMph);
    // Below a threshold the tires are just rolling; scrub is what happens past it.
    const scrub = Math.max(0, saturation - 0.55) / 0.45;
    set(this.scrubGain.gain, Math.min(0.12, scrub * 0.11 * Math.min(1, speed / 6) + slipping * 0.03), 0.07);

    // --- Road / wind --------------------------------------------------------
    set(this.roadGain.gain, Math.min(0.07, speed * 0.0022), 0.12);
    set(this.roadFilter.frequency, 260 + speed * 26, 0.12);

    this.updateAirEvents(rig);
    this.updateShiftEvents(pt);
  }

  /** Air brake noises, fired off transitions rather than levels. */
  updateAirEvents(rig) {
    const air = rig.air;

    if (this._lastParkingBrake !== null && air.parkingBrake !== this._lastParkingBrake) {
      // Setting the parking brake dumps air; releasing it fills the chambers.
      if (air.parkingBrake) this.hiss(0.16, 0.55, 900, 0.7);
      else this.hiss(0.13, 0.42, 1500, 0.9);
    }
    this._lastParkingBrake = air.parkingBrake;

    // The governor cutting in and out is the sound a parked truck makes all day.
    if (air.psi > this._lastPsi + 0.6) this.hiss(0.03, 0.25, 700, 1.6);
    this._lastPsi = air.psi;
  }

  /** A short pop of air at each shift, the way an air-shifted box sounds. */
  updateShiftEvents(pt) {
    const gear = pt.neutral ? 'N' : pt.inReverse ? `R${pt.reverseGear}` : pt.gear;
    if (this._lastGear !== null && gear !== this._lastGear) {
      this.hiss(0.05, 0.14, 2200, 1.1);
    }
    this._lastGear = gear;
  }

  // ---------------------------------------------------------------------------
  // Mixing
  // ---------------------------------------------------------------------------

  setMuted(muted) {
    this.muted = muted;
    AudioEngine.saveMuted(muted);
    this.applyMasterGain();
  }

  /**
   * Silences everything while the game is paused without disturbing the
   * player's own mute setting, so unpausing restores whatever they chose.
   */
  setSuspended(suspended) {
    this.suspended = suspended;
    this.applyMasterGain();
  }

  applyMasterGain() {
    if (!this.enabled) return;
    const target = this.muted || this.suspended ? 0 : 0.85;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.04);
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Autoplay policy suspends the context until a gesture resumes it. */
  resume() {
    if (this.enabled && this.ctx.state === 'suspended') this.ctx.resume();
  }

  static loadMuted() {
    try {
      return globalThis.localStorage?.getItem('heavyhaul.muted') === '1';
    } catch {
      return false;
    }
  }

  static saveMuted(muted) {
    try {
      globalThis.localStorage?.setItem('heavyhaul.muted', muted ? '1' : '0');
    } catch {
      // Private browsing and the like. Not worth failing over.
    }
  }
}
