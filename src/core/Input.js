/**
 * Keyboard and gamepad input.
 *
 * Steering is rate-limited rather than instant: a real steering box takes about
 * five turns lock to lock, and a load this heavy punishes fast corrections. The
 * analog ramp here is what stops a keyboard from being able to yank the wheel
 * in a way no driver could.
 */
export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.pressed = new Set();
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.trailerSteer = 0;

    this.bindings = {
      steerLeft: ['KeyA', 'ArrowLeft'],
      steerRight: ['KeyD', 'ArrowRight'],
      throttle: ['KeyW', 'ArrowUp'],
      brake: ['KeyS', 'ArrowDown'],
      trailerLeft: ['KeyQ'],
      trailerRight: ['KeyE'],
      shiftUp: ['ShiftLeft', 'ShiftRight'],
      shiftDown: ['ControlLeft', 'ControlRight'],
      engineBrake: ['KeyB'],
      parkingBrake: ['Space'],
      reverse: ['KeyR'],
      neutral: ['KeyN'],
      diffLock: ['KeyF'],
      camera: ['KeyC'],
      lookBack: ['KeyX'],
      autoShift: ['KeyT'],
      resetRig: ['KeyP'],
      axleLift: ['KeyL'],
    };

    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Don't swallow browser shortcuts the player may need.
      if (e.metaKey || e.altKey) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (this.isBound(e.code)) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
  }

  isBound(code) {
    for (const codes of Object.values(this.bindings)) {
      if (codes.includes(code)) return true;
    }
    return false;
  }

  down(action) {
    return this.bindings[action].some((c) => this.keys.has(c));
  }

  /** True once per press. Cleared by endFrame(). */
  tapped(action) {
    return this.bindings[action].some((c) => this.pressed.has(c));
  }

  get gamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  update(dt) {
    const pad = this.gamepad;

    // --- Steering -----------------------------------------------------------
    let steerTarget = 0;
    if (pad) {
      const axis = pad.axes[0] ?? 0;
      steerTarget = Math.abs(axis) > 0.08 ? axis : 0;
    }
    if (this.down('steerLeft')) steerTarget = -1;
    if (this.down('steerRight')) steerTarget = 1;

    // Ramp toward the target, and return to centre faster than you can wind on
    // lock -- which is how a real box with caster behaves.
    const onRate = 1.9;
    const offRate = 3.2;
    const rate = steerTarget === 0 ? offRate : onRate;
    const delta = steerTarget - this.steer;
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, delta));
    if (steerTarget === 0 && Math.abs(this.steer) < 0.02) this.steer = 0;

    // --- Pedals -------------------------------------------------------------
    let throttleTarget = this.down('throttle') ? 1 : 0;
    let brakeTarget = this.down('brake') ? 1 : 0;
    if (pad) {
      throttleTarget = Math.max(throttleTarget, pad.buttons[7]?.value ?? 0);
      brakeTarget = Math.max(brakeTarget, pad.buttons[6]?.value ?? 0);
    }
    // Pedals move quickly but not instantly; air brakes have their own lag on
    // top of this.
    this.throttle += Math.max(-6 * dt, Math.min(4 * dt, throttleTarget - this.throttle));
    this.brake += Math.max(-8 * dt, Math.min(6 * dt, brakeTarget - this.brake));
    this.throttle = Math.max(0, Math.min(1, this.throttle));
    this.brake = Math.max(0, Math.min(1, this.brake));

    // --- Trailer rear steer -------------------------------------------------
    let tTarget = 0;
    if (this.down('trailerLeft')) tTarget = -1;
    if (this.down('trailerRight')) tTarget = 1;
    if (pad && Math.abs(pad.axes[2] ?? 0) > 0.15) tTarget = pad.axes[2];
    this.trailerSteer += Math.max(-1.6 * dt, Math.min(1.6 * dt, tTarget - this.trailerSteer));
    if (tTarget === 0) this.trailerSteer *= Math.exp(-2.5 * dt);
  }

  endFrame() {
    this.pressed.clear();
  }
}
