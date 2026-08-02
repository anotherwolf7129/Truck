import { Vector3, Group, Quaternion, Euler, Color, MathUtils } from 'three';
import { RenderContext } from './render/Scene.js';
import { WorldMesh } from './render/WorldMesh.js';
import {
  createTractor, createJeep, createLowboy, createWheel,
  createPoliceCar, createPilotCar, createTrafficVehicle,
} from './render/Models.js';
import { Route } from './world/Route.js';
import { Ground } from './world/Ground.js';
import { Rig } from './physics/Rig.js';
import { ConvoyManager, Role } from './ai/Escort.js';
import { TrafficManager } from './ai/Traffic.js';
import { Input } from './core/Input.js';
import { HUD } from './ui/HUD.js';
import { Debrief } from './ui/Debrief.js';
import { AudioEngine } from './audio/Audio.js';
import { Scorecard } from './mission/Scorecard.js';

const _v = new Vector3();
const _q = new Quaternion();
const _e = new Euler();
const _e2 = new Euler();

// Tail lamp states for the kinematic vehicles.
const TAIL_DIM = new Color(0xff2a1a).multiplyScalar(0.5);
const TAIL_BRAKE = new Color(0xff2a1a).multiplyScalar(2.4);
const TAIL_HAZARD = new Color(0xffa000).multiplyScalar(2.2);

const FIXED_DT = 1 / 200;
const MAX_STEPS = 12;

/** Camera modes, cycled with C. */
const CAMERAS = ['chase', 'cab', 'hood', 'trailer', 'cinematic'];

export class Game {
  constructor(canvas, hudRoot) {
    this.render = new RenderContext(canvas);
    this.input = new Input();

    // --- World --------------------------------------------------------------
    this.route = new Route();
    this.ground = new Ground(this.route);
    this.worldMesh = new WorldMesh(this.route, this.ground);
    this.render.scene.add(this.worldMesh.group);

    // --- The rig ------------------------------------------------------------
    this.rig = new Rig({
      cargo: {
        name: 'Substation transformer, 400 MVA',
        mass: 68000,
        size: new Vector3(3.66, 3.60, 8.40),
        centerHeight: 2.35,
      },
    });
    // Overall height of the load above the road, which is what the permit and
    // every bridge on the route care about.
    this.loadHeight = 0.55 + this.rig.cargo.size.y;
    this.rig.loadHeight = this.loadHeight;

    this.buildRigVisuals();

    // --- Convoy and traffic --------------------------------------------------
    this.convoy = new ConvoyManager(this.route, this.rig);
    this.traffic = new TrafficManager(this.route, { density: 1 });
    this.buildEscortVisuals();
    this.trafficVisuals = new Map();
    this.blockadeVisuals = new Map();
    // Free list of retired vehicle meshes, keyed by kind. Traffic recycles
    // continuously for the whole move, and every one of these meshes owns its
    // own geometry and paint -- so they are handed back and reused rather than
    // dropped on the floor for the GPU to accumulate.
    this.vehiclePool = new Map();
    this.prewarmVehicles();

    // --- State ---------------------------------------------------------------
    this.convoyS = 0;
    this.convoySpeed = 0;
    this.convoyLateral = this.route.convoyLaneOffset(0);
    this.advisoryMph = 45;
    this.clockHour = 9.25;
    this.cameraMode = 'chase';
    this.autoShift = true;
    this.clearanceAlarm = null;
    this.offRoute = false;
    this.paused = false;
    this.accumulator = 0;
    this.elapsed = 0;
    this.finished = false;

    this.cameraPos = new Vector3();
    this.cameraLook = new Vector3();
    this._camInit = false;

    this.hud = new HUD(hudRoot);
    this.hud.setPermit(this.rig, this.route);
    this.debrief = new Debrief(hudRoot);
    this.debrief.onRestart = () => this.reset();

    // Silent until attachAudio() is called from a user gesture -- the browser
    // will not give us a running context before then.
    this.audio = new AudioEngine(null);
    // Every radio call gets a squelch click ahead of it. `Radio` already
    // supports listeners; this is the first thing to use one.
    this.convoy.radio.listeners.push((msg) => this.audio.chirp(msg.priority));

    // Start the world at the same time the dash is showing.
    this.render.setTimeOfDay(this.clockHour);

    // A backgrounded tab should not keep driving the load.
    globalThis.document?.addEventListener('visibilitychange', () => {
      if (document.hidden) this.setPaused(true);
    });

    this.reset();
  }

  // ---------------------------------------------------------------------------
  // Visual construction
  // ---------------------------------------------------------------------------

  buildRigVisuals() {
    this.unitVisuals = [];

    const specs = [
      { unit: this.rig.tractor, mesh: createTractor() },
      { unit: this.rig.jeep, mesh: createJeep() },
      { unit: this.rig.trailer, mesh: createLowboy(this.rig.cargo, this.rig.trailer.comHeight) },
    ];

    for (const { unit, mesh } of specs) {
      const group = new Group();
      group.add(mesh);

      // One visual wheel per physics wheel, parented to the unit so they
      // inherit its motion and only need local suspension travel applied.
      const wheelMeshes = unit.wheels.map((w) => {
        const wm = createWheel(w.radius, w.width, w.dual);
        group.add(wm);
        return wm;
      });

      this.render.scene.add(group);
      this.unitVisuals.push({ unit, group, body: mesh, wheelMeshes });
    }
  }

  buildEscortVisuals() {
    this.escortVisuals = this.convoy.vehicles.map((v) => {
      const mesh = v.isPolice
        ? createPoliceCar()
        : createPilotCar(v.role === Role.LEAD_PILOT ? this.loadHeight + 0.08 : 0.01);
      // Only the lead car runs a height pole.
      if (v.role !== Role.LEAD_PILOT && mesh.userData.pole) {
        mesh.remove(mesh.userData.pole);
        mesh.userData.pole = null;
      }
      this.render.scene.add(mesh);
      return { vehicle: v, mesh };
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  reset() {
    const startS = this.route.staging.s;
    const pos = this.route.positionAt(startS, this.route.convoyLaneOffset(startS), new Vector3());
    const heading = this.route.headingAt(startS);

    this.rig.placeAt(pos, heading, this.ground);
    this.rig.air.psi = 120;
    this.rig.air.parkingBrake = true;
    this.rig.powertrain.gear = 2;
    this.rig.powertrain.rpm = this.rig.powertrain.idleRpm;

    this.convoyS = startS;
    this.convoySpeed = 0;
    this.convoy.reset(startS);
    this.finished = false;
    this._camInit = false;
    this.elapsed = 0;
    this.clockHour = 9.25;

    // A fresh sheet. The old one has already been shown by the time we get here.
    this.scorecard = new Scorecard(this.route, this.loadHeight);
    this.debrief.hide();
    this.setPaused(false);

    this.convoy.radio.say('Dispatch',
      `Permit is live. ${Math.round(this.rig.grossWeightLb).toLocaleString()} lb gross, ` +
      `${(this.loadHeight * 3.28084).toFixed(2)} ft high. Release the parking brake when you're ready.`,
      { time: 0 });
    this.convoy.radio.say('Lead', 'Lead car is out front with the pole. Chase is behind you. Take your time.', { time: 0 });
  }

  /**
   * Teleports the whole convoy to a point on the route.
   *
   * Used for inspecting or testing a specific feature -- the switchback, a
   * bridge, a blocked junction -- without driving the seven miles to reach it.
   */
  jumpTo(s, speedMph = 0) {
    const pos = this.route.positionAt(s, this.route.convoyLaneOffset(s), new Vector3());
    const heading = this.route.headingAt(s);
    this.rig.placeAt(pos, heading, this.ground);
    this.rig.air.parkingBrake = speedMph === 0;

    if (speedMph > 0) {
      const v = speedMph / 2.23694;
      const dir = new Vector3(Math.sin(heading), 0, Math.cos(heading));
      for (const unit of this.rig.units) unit.body.velocity.copy(dir).multiplyScalar(v);
      for (const unit of this.rig.units) {
        for (const w of unit.wheels) w.spin = v / w.radius;
      }
      // Pick the gear that actually suits this speed rather than letting the
      // shift assist walk to it one ratio at a time.
      const pt = this.rig.powertrain;
      let best = 0;
      let bestErr = Infinity;
      for (let g = 0; g < 18; g++) {
        const rpm = pt.speedAtRpm(1, 0.512, g) > 0
          ? (v / (pt.speedAtRpm(1, 0.512, g))) : Infinity;
        const err = Math.abs(rpm - 1500);
        if (rpm > 900 && rpm < 1900 && err < bestErr) { bestErr = err; best = g; }
      }
      pt.gear = best;
      pt.rpm = Math.max(pt.idleRpm, Math.min(pt.maxRpm, v / pt.speedAtRpm(1, 0.512, best)));
    }

    this.convoyS = s;
    this.convoySpeed = speedMph / 2.23694;
    this.convoy.reset(s);
    this._camInit = false;
    // The road behind the jump was never driven, so it is not scored.
    this.scorecard.skipTo(s);

    // Let the suspension find the road before handing control back, otherwise
    // the rig arrives airborne and the first second of every jump is a landing.
    for (let i = 0; i < 400; i++) this.rig.step(FIXED_DT, this.ground);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  handleInput(dt) {
    const input = this.input;
    const rig = this.rig;
    input.update(dt);

    rig.steerInput = input.steer;
    rig.throttle = input.throttle;
    rig.brake = input.brake;
    rig.trailerSteerInput = input.trailerSteer;

    if (input.tapped('parkingBrake')) {
      if (rig.air.parkingBrake) {
        if (rig.air.releaseParkingBrake()) {
          this.convoy.radio.say('Lead', 'Brakes are off. Rolling. Watch your tail through the gate.',
            { time: this.convoy.time });
        }
      } else {
        rig.air.parkingBrake = true;
      }
    }

    if (input.tapped('autoShift')) this.autoShift = !this.autoShift;
    if (input.tapped('steerman')) {
      rig.autoTrailerSteer = !rig.autoTrailerSteer;
      this.convoy.radio.say('Lead',
        rig.autoTrailerSteer
          ? 'Steerman has the rear axles. He will follow you round.'
          : 'Rear axles are yours -- Q and E. Steerman is off the box.',
        { time: this.convoy.time });
    }
    if (!this.autoShift) {
      if (input.tapped('shiftUp')) rig.powertrain.shiftUp();
      if (input.tapped('shiftDown')) rig.powertrain.shiftDown();
    }
    if (input.tapped('reverse')) rig.powertrain.selectReverse();
    if (input.tapped('neutral')) rig.powertrain.neutral = !rig.powertrain.neutral;
    if (input.tapped('diffLock')) rig.diffLock = !rig.diffLock;
    if (input.tapped('engineBrake')) {
      rig.powertrain.engineBrakeStage = (rig.powertrain.engineBrakeStage + 1) % 4;
    }
    if (input.tapped('camera')) {
      const i = CAMERAS.indexOf(this.cameraMode);
      this.cameraMode = CAMERAS[(i + 1) % CAMERAS.length];
      this._camInit = false;
    }
    if (input.tapped('axleLift')) {
      // Lifting an axle takes weight off the road but puts it on the others --
      // useful for tight turns, illegal to run loaded on.
      for (const w of rig.trailer.wheels) {
        if (w.liftable) w.lifted = !w.lifted;
      }
    }
    if (input.tapped('resetRig')) this.reset();
    if (input.tapped('mute')) this.audio.toggleMute();
  }

  /** Runs the physics at a fixed rate regardless of frame rate. */
  stepPhysics(dt) {
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      if (this.autoShift) {
        this.rig.powertrain.autoShift(FIXED_DT, 0.512, this.rig.tractor.forwardSpeed);
      }
      this.rig.step(FIXED_DT, this.ground);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    // If the tab was backgrounded, drop the backlog rather than fast-forwarding.
    if (steps === MAX_STEPS) this.accumulator = 0;
  }

  updateRouteState(dt = 0) {
    const p = this.rig.tractor.body.position;
    const proj = this.route.project(p.x, p.z);
    this.convoyS = proj.s;
    this.convoySpeed = this.rig.tractor.forwardSpeed;
    // Where the load is sitting across the road, so the escorts and the traffic
    // give way to where it actually is rather than where the lane is.
    const load = this.route.project(this.rig.trailer.body.position.x, this.rig.trailer.body.position.z);
    this.convoyLateral = load.lateral;
    this.advisoryMph = this.route.advisorySpeedAt(this.convoyS);
    this.speedLimitMph = this.route.speedLimitAt(this.convoyS);
    this.offRoute = Math.abs(proj.lateral) > this.route.halfWidthAt(this.convoyS) + 6;

    // The next light, and whether anybody has it. Both go on the dash: a red
    // with no unit on it is the one thing on this route that can stop the load.
    this.nextSignal = null;
    const signalJunction = this.route.nextSignal(this.convoyS);
    if (signalJunction && signalJunction.s - this.convoyS < 700) {
      const blockade = this.convoy.blockades.find((b) => b.junction === signalJunction);
      this.nextSignal = {
        name: signalJunction.name,
        distance: signalJunction.s - this.convoyS,
        phase: blockade?.signal?.mainline ?? 'green',
        held: !!blockade?.active,
      };
    }

    // Clearance check against the next bridge, using the top of the load.
    this.clearanceAlarm = null;
    const bridge = this.route.nextBridge(this.convoyS);
    if (bridge && bridge.s - this.convoyS < 260) {
      const margin = bridge.clearance - this.loadHeight;
      const dist = Math.round(bridge.s - this.convoyS);
      if (margin < 0) {
        this.clearanceAlarm = `${bridge.name} is ${(bridge.clearance * 3.28084).toFixed(2)} ft — the load will not fit`;
      } else if (margin < 0.25) {
        this.clearanceAlarm = `${bridge.name} in ${dist} m — only ${(margin * 100).toFixed(0)} cm of clearance`;
      }
    }

    if (this.finished) return;

    // Scored before the end checks below, so the frame that ends the move is
    // itself part of the record rather than being thrown away.
    this.scorecard.observe(dt, this.rig, this.convoy, this.convoyS, proj.lateral);

    if (this.convoyS >= this.route.destination.s) {
      this.convoy.radio.say('Dispatch',
        `That's the yard. Load delivered, ${(this.elapsed / 60).toFixed(0)} minutes on the road. Good move.`,
        { priority: 'critical', time: this.convoy.time });
      this.endMove('delivered');
    } else if (this.rig.telemetry.rollover >= 1.4) {
      // Same threshold the mission test treats as over: past this the load is
      // on its side and there is no driving out of it.
      this.convoy.radio.say('Lead',
        'It\'s over. Load is on its side — everybody stop, shut the road down.',
        { priority: 'critical', time: this.convoy.time });
      this.endMove('rolled');
    }
  }

  /** Closes out the move and raises the debrief. */
  endMove(outcome) {
    this.finished = true;
    this.scorecard.finish(outcome);
    this.debrief.show(this.scorecard, this.route);
  }

  // ---------------------------------------------------------------------------
  // Visual sync
  // ---------------------------------------------------------------------------

  syncRig() {
    for (const vis of this.unitVisuals) {
      const body = vis.unit.body;
      vis.group.position.copy(body.position);
      vis.group.quaternion.copy(body.quaternion);

      vis.unit.wheels.forEach((w, i) => {
        const wm = vis.wheelMeshes[i];
        wm.visible = !w.lifted;
        if (w.lifted) return;
        // Local position: strut mount dropped by the current suspension length.
        wm.position.set(w.position.x, w.position.y - w.lastLength, w.position.z);
        _e.set(w.spinAngle, w.steerAngle, 0, 'YXZ');
        wm.quaternion.setFromEuler(_e);
      });
    }
  }

  /**
   * Puts a kinematic vehicle's mesh on the road.
   *
   * These vehicles are simulated as an arc length and a lane offset, so their
   * pose has to be reconstructed here: sat on the terrain, pitched with the
   * grade, yawed into whatever lateral move they are making, and with the wheels
   * rolling and steering to match. Without the last part they read as boxes
   * sliding along the road rather than cars driving down it.
   */
  placeRoadVehicle(mesh, pose, heading, { brake = false, hazard = false } = {}) {
    const p = pose.position;
    // Sat on the paved surface, taken from the pose's own elevation rather than
    // from a terrain query. The pose is already a point on the route, so its
    // height is the road's -- asking the ground for it again costs a projection
    // per vehicle per frame and answers a question we have the answer to. The
    // camber is the same shed the road mesh and the physics both use.
    mesh.position.set(p.x, p.y - Math.abs(pose.lateral ?? 0) * 0.02, p.z);
    _e.set(pose.pitch, heading, 0, 'YXZ');
    mesh.quaternion.setFromEuler(_e);

    const wheels = mesh.userData.wheels;
    if (wheels) {
      _e2.set(pose.wheelSpin, 0, 0, 'YXZ');
      for (const w of wheels) w.quaternion.setFromEuler(_e2);
      _e2.set(pose.wheelSpin, pose.steerAngle, 0, 'YXZ');
      for (const w of mesh.userData.steeredWheels ?? []) w.quaternion.setFromEuler(_e2);
    }

    const tails = mesh.userData.tailLights;
    if (tails) {
      const flash = hazard && Math.sin(this.elapsed * 6) > 0;
      const colour = flash ? TAIL_HAZARD : (brake ? TAIL_BRAKE : TAIL_DIM);
      for (const t of tails) t.material.color.copy(colour);
    }
  }

  syncEscorts(dt) {
    const t = this.elapsed;
    for (const { vehicle, mesh } of this.escortVisuals) {
      this.placeRoadVehicle(mesh, vehicle.pose, vehicle.heading, {
        brake: vehicle.speed < this.convoySpeed - 1,
      });

      // Beacons: police alternate red and blue, pilot cars run amber.
      const beacons = mesh.userData.beacons;
      if (!beacons) continue;
      const on = vehicle.lightsOn;
      if (beacons.reds) {
        // Fast alternating pattern, the way a real light bar cycles.
        const phase = Math.floor((t * 5.5 + vehicle.lightPhase) % 2);
        for (const l of beacons.reds) l.visible = on && phase === 0;
        for (const l of beacons.blues) l.visible = on && phase === 1;
      }
      if (beacons.ambers) {
        const flash = (Math.sin(t * 7 + vehicle.lightPhase) > 0);
        for (const l of beacons.ambers) l.visible = on && flash;
      }
    }
  }

  /**
   * Builds a road's worth of traffic up front and parks it in the pool.
   *
   * A car is a dozen geometries, a merge pass and a shader compile the first
   * time its material is seen. Doing that the instant a vehicle spawns puts all
   * of it inside one frame, and a car appearing over the crest ahead is exactly
   * when a stutter is least welcome. The pool is filled at load instead, where
   * there is already a loading screen to hide it.
   */
  prewarmVehicles() {
    for (let i = 0; i < 16; i++) this.releaseVehicle('car', createTrafficVehicle('car', i / 16));
    for (let i = 0; i < 6; i++) this.releaseVehicle('truck', createTrafficVehicle('truck', i / 6));
    // Everything in the pool starts hidden but parented, so the first frame a
    // vehicle is used is a transform update rather than a scene-graph insert.
    for (const list of this.vehiclePool.values()) {
      for (const mesh of list) this.render.scene.add(mesh);
    }
  }

  /**
   * Takes a vehicle mesh of the given kind from the pool, or builds one.
   *
   * Pooled cars keep whatever paint they were built with, which is fine -- the
   * pool fills up with the same spread of colours the seed would have produced.
   */
  acquireVehicle(kind, seed) {
    const free = this.vehiclePool.get(kind);
    const mesh = free?.pop() ?? createTrafficVehicle(kind, seed);
    mesh.visible = true;
    if (!mesh.parent) this.render.scene.add(mesh);
    return mesh;
  }

  /** Hands a mesh back for reuse rather than orphaning its geometry. */
  releaseVehicle(kind, mesh) {
    mesh.visible = false;
    let free = this.vehiclePool.get(kind);
    if (!free) this.vehiclePool.set(kind, (free = []));
    free.push(mesh);
  }

  syncTraffic() {
    const seen = new Set();
    for (const v of this.traffic.vehicles) {
      seen.add(v.id);
      let entry = this.trafficVisuals.get(v.id);
      if (!entry) {
        entry = { kind: v.kind, mesh: this.acquireVehicle(v.kind, (v.id * 0.37) % 1) };
        this.trafficVisuals.set(v.id, entry);
      }
      this.placeRoadVehicle(entry.mesh, v.pose, v.heading, {
        brake: v.brakeLight || v.speed < 0.2,
        hazard: v.hazards,
      });
    }
    // Retire meshes whose vehicles have been recycled.
    for (const [id, entry] of this.trafficVisuals) {
      if (!seen.has(id)) {
        this.releaseVehicle(entry.kind, entry.mesh);
        this.trafficVisuals.delete(id);
      }
    }
  }

  /** Cars waiting at the blocked side roads, and traffic on the cross streets. */
  syncBlockades() {
    const seen = new Set();
    for (const b of this.convoy.blockades) {
      // A four-way has traffic on it that is going somewhere. It is held on the
      // stop line while a unit has the light and crosses in front of the convoy
      // the rest of the time, which is most of what a town looks like from a cab.
      for (const v of b.cross?.vehicles ?? []) {
        const key = `x${v.id}`;
        seen.add(key);
        let entry = this.blockadeVisuals.get(key);
        if (!entry) {
          entry = { kind: v.kind, mesh: this.acquireVehicle(v.kind, (v.id * 0.29) % 1) };
          this.blockadeVisuals.set(key, entry);
        }
        this.placeRoadVehicle(entry.mesh, v, v.heading, { brake: v.brakeLight || v.speed < 0.3 });
        entry.mesh.visible = true;
      }

      for (let i = 0; i < b.queue.length; i++) {
        const c = b.queue[i];
        const key = `${b.name}:${i}`;
        seen.add(key);
        let entry = this.blockadeVisuals.get(key);
        if (!entry) {
          entry = { kind: c.kind, mesh: this.acquireVehicle(c.kind, (i * 0.41 + b.queueSeed) % 1) };
          this.blockadeVisuals.set(key, entry);
        }
        // On the side road's own surface, which is a flat apron at the junction's
        // elevation rather than the terrain -- the same plane the pavement mesh
        // is built on, so the queue sits on the road instead of in the verge.
        entry.mesh.position.copy(c.position);
        entry.mesh.rotation.y = c.heading;
        // Only render the queue while the convoy is close enough to see it.
        entry.mesh.visible = Math.abs(b.s - this.convoyS) < 500;
      }
    }
    // A reset empties the queues; their cars go back in the pool with the rest.
    for (const [key, entry] of this.blockadeVisuals) {
      if (!seen.has(key)) {
        this.releaseVehicle(entry.kind, entry.mesh);
        this.blockadeVisuals.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  updateCamera(dt) {
    const tractor = this.rig.tractor.body;
    const trailer = this.rig.trailer.body;
    const cam = this.render.camera;

    let desiredPos = _v;
    let lookAt = new Vector3();
    let stiffness = 6;

    switch (this.cameraMode) {
      case 'cab': {
        // Seated in the cab: high up and well behind the front axle, which is
        // why the nose of a conventional feels so far away.
        tractor.localToWorld(new Vector3(-0.62, 1.28, 0.75), desiredPos);
        tractor.localToWorld(new Vector3(-0.62, 1.20, 12), lookAt);
        stiffness = 40;
        break;
      }
      case 'hood': {
        tractor.localToWorld(new Vector3(0, 1.05, 3.0), desiredPos);
        tractor.localToWorld(new Vector3(0, 0.95, 18), lookAt);
        stiffness = 24;
        break;
      }
      case 'trailer': {
        // Looking forward over the load from behind, which is how you actually
        // watch the rear axles track through a corner.
        trailer.localToWorld(new Vector3(0, 2.6, -11.5), desiredPos);
        trailer.localToWorld(new Vector3(0, 1.2, 6), lookAt);
        stiffness = 8;
        break;
      }
      case 'cinematic': {
        // A slow drift alongside the load, roughly where an escort would ride.
        const angle = this.elapsed * 0.08;
        const radius = 26;
        desiredPos.copy(trailer.position).add(new Vector3(
          Math.cos(angle) * radius, 6 + Math.sin(angle * 0.7) * 3, Math.sin(angle) * radius
        ));
        lookAt.copy(trailer.position).add(new Vector3(0, 1.5, 0));
        stiffness = 2.2;
        break;
      }
      default: {
        // Chase. The combination is 87 ft long, so the camera has to sit behind
        // the *trailer*, not the tractor -- anchoring it to the cab puts it
        // inside the load.
        const looking = this.input.down('lookBack');

        // Midpoint of the whole combination, which is what we frame.
        const centre = new Vector3()
          .addVectors(tractor.position, trailer.position)
          .multiplyScalar(0.5);

        // Heading of the tractor, flattened, so the camera trails the direction
        // of travel rather than swinging with body roll.
        const fwd = tractor.localToWorldDir(new Vector3(0, 0, 1), new Vector3());
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
        fwd.normalize();

        const back = looking ? 40 : -40;
        desiredPos.copy(centre).addScaledVector(fwd, back);
        desiredPos.y = centre.y + 13.5;

        lookAt.copy(centre);
        lookAt.y += 1.2;
        stiffness = 4;
      }
    }

    // Keep the camera above the road no matter what the terrain does.
    const groundY = this.ground.heightAt(desiredPos.x, desiredPos.z) + 1.2;
    if (desiredPos.y < groundY) desiredPos.y = groundY;

    if (!this._camInit) {
      this.cameraPos.copy(desiredPos);
      this.cameraLook.copy(lookAt);
      this._camInit = true;
    }
    const k = 1 - Math.exp(-stiffness * dt);
    this.cameraPos.lerp(desiredPos, k);
    this.cameraLook.lerp(lookAt, k);

    cam.position.copy(this.cameraPos);
    cam.lookAt(this.cameraLook);

    // A touch of speed-based field of view so 25 mph in a loaded rig still
    // reads as motion.
    const speed = Math.abs(this.rig.speedMph);
    const targetFov = this.cameraMode === 'cinematic' ? 42 : 56 + Math.min(10, speed * 0.22);
    cam.fov += (targetFov - cam.fov) * Math.min(1, 3 * dt);
    cam.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  /**
   * Switches the sound on. Must be called from a user gesture.
   *
   * Kept out of the constructor so that constructing a Game never depends on an
   * AudioContext being available -- the tools and any headless use still work.
   */
  attachAudio() {
    this.audio = AudioEngine.create();
    this.audio.resume();
    return this.audio;
  }

  /** Pauses or resumes, and shows the overlay. */
  setPaused(paused) {
    this.paused = paused;
    this.hud.setPaused(paused);
    this.audio.setSuspended(paused);
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    this.elapsed += dt;
    this.clockHour += dt / 3600;

    // The sun tracks the dash clock. `setTimeOfDay` rebuilds the reflection
    // probe, which is far too expensive to do every frame, so it only runs once
    // the clock has actually moved -- about once a minute of real time.
    if (Math.abs(this.clockHour - this.render.hour) > 0.02) {
      this.render.setTimeOfDay(this.clockHour);
    }

    this.handleInput(dt);
    this.stepPhysics(dt);
    this.updateRouteState(dt);

    const load = {
      lateral: this.convoyLateral,
      halfWidth: this.rig.cargo.size.x * 0.5,
      length: this.convoy.convoyLength,
    };
    // A unit crossing to a side road looks before it swings over.
    this.convoy.traffic = this.traffic.vehicles;
    this.convoy.update(dt, this.convoyS, this.convoySpeed, this.loadHeight, load);
    this.traffic.update(dt, {
      convoy: { s: this.convoyS, speed: this.convoySpeed, ...load },
      escorts: this.convoy.vehicles,
      blockades: this.convoy.blockades,
      route: this.route,
    });

    this.syncRig();
    this.syncEscorts(dt);
    this.syncTraffic();
    this.syncBlockades();
    this.worldMesh.updateSignals(this.route.signals);
    this.updateCamera(dt);
    this.worldMesh.updateVisibility(this.render.camera.position);

    this.render.update(this.rig.tractor.body.position);
    this.audio.update(dt, this.rig);
    this.hud.update(this);
  }

  start() {
    let last = performance.now();
    const loop = (now) => {
      const dt = (now - last) / 1000;
      last = now;

      // The pause toggle and the frame's input bookkeeping both live out here
      // rather than in update(): a paused game does not run update(), so a
      // toggle checked in there could never be seen again once it had fired.
      if (this.input.tapped('pause')) this.setPaused(!this.paused);
      if (!this.paused) this.update(dt);
      this.render.adaptResolution(dt);
      this.render.render();
      this.input.endFrame();

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
