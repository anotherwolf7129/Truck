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

    // --- State ---------------------------------------------------------------
    this.convoyS = 0;
    this.convoySpeed = 0;
    this.convoyLateral = this.route.laneWidth * 0.5;
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
    this.hud.setPermit(Object.assign(this.rig, { loadHeight: this.loadHeight }), this.route);

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
    const pos = this.route.positionAt(startS, this.route.laneWidth * 0.5, new Vector3());
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
    const pos = this.route.positionAt(s, this.route.laneWidth * 0.5, new Vector3());
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

  updateRouteState() {
    const p = this.rig.tractor.body.position;
    const proj = this.route.project(p.x, p.z);
    this.convoyS = proj.s;
    this.convoySpeed = this.rig.tractor.forwardSpeed;
    // Where the load is sitting across the road, so the escorts and the traffic
    // give way to where it actually is rather than where the lane is.
    const load = this.route.project(this.rig.trailer.body.position.x, this.rig.trailer.body.position.z);
    this.convoyLateral = load.lateral;
    this.advisoryMph = this.route.advisorySpeedAt(this.convoyS);
    this.offRoute = Math.abs(proj.lateral) > this.route.roadHalfWidth + 6;

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

    if (!this.finished && this.convoyS >= this.route.destination.s) {
      this.finished = true;
      this.convoy.radio.say('Dispatch',
        `That's the yard. Load delivered, ${(this.elapsed / 60).toFixed(0)} minutes on the road. Good move.`,
        { priority: 'critical', time: this.convoy.time });
    }
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
    mesh.position.set(p.x, this.ground.heightAt(p.x, p.z), p.z);
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

  syncTraffic() {
    const seen = new Set();
    for (const v of this.traffic.vehicles) {
      seen.add(v.id);
      let mesh = this.trafficVisuals.get(v.id);
      if (!mesh) {
        mesh = createTrafficVehicle(v.kind, (v.id * 0.37) % 1);
        this.render.scene.add(mesh);
        this.trafficVisuals.set(v.id, mesh);
      }
      this.placeRoadVehicle(mesh, v.pose, v.heading, {
        brake: v.brakeLight || v.speed < 0.2,
        hazard: v.hazards,
      });
    }
    // Retire meshes whose vehicles have been recycled.
    for (const [id, mesh] of this.trafficVisuals) {
      if (!seen.has(id)) {
        this.render.scene.remove(mesh);
        this.trafficVisuals.delete(id);
      }
    }
  }

  /** Cars waiting at the blocked side roads. */
  syncBlockades() {
    for (const b of this.convoy.blockades) {
      for (let i = 0; i < b.queue.length; i++) {
        const key = `${b.name}:${i}`;
        let mesh = this.blockadeVisuals.get(key);
        if (!mesh) {
          mesh = createTrafficVehicle(b.queue[i].kind, (i * 0.41 + b.queueSeed) % 1);
          this.render.scene.add(mesh);
          this.blockadeVisuals.set(key, mesh);
        }
        const c = b.queue[i];
        const h = this.ground.heightAt(c.position.x, c.position.z);
        mesh.position.set(c.position.x, h, c.position.z);
        mesh.rotation.y = c.heading;
        // Only render the queue while the convoy is close enough to see it.
        mesh.visible = Math.abs(b.s - this.convoyS) < 500;
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

  update(dt) {
    dt = Math.min(dt, 0.1);
    this.elapsed += dt;
    this.clockHour += dt / 3600;

    this.handleInput(dt);
    this.stepPhysics(dt);
    this.updateRouteState();

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
    this.updateCamera(dt);

    this.render.update(this.rig.tractor.body.position);
    this.hud.update(this);
    this.input.endFrame();
  }

  render_() {
    this.render.render();
  }

  start() {
    let last = performance.now();
    const loop = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!this.paused) {
        this.update(dt);
        this.render.render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
