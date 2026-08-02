import {
  WebGLRenderer, Scene, PerspectiveCamera, DirectionalLight, HemisphereLight,
  ACESFilmicToneMapping, PCFSoftShadowMap, Vector3, Fog, SRGBColorSpace,
  PMREMGenerator, Color, MathUtils, ShaderMaterial, BackSide, SphereGeometry, Mesh,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

const _target = new Vector3();

/**
 * Owns the renderer, camera, lighting and sky.
 *
 * The shadow camera is retargeted every frame to a tight box around the rig
 * rather than covering the whole route -- an 87 foot combination needs crisp
 * contact shadows under two dozen wheels, and a route-sized shadow map would
 * put each wheel inside a single texel.
 */
export class RenderContext {
  constructor(canvas) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    // Resolution is a scale on the device pixel ratio rather than a fixed
    // number, so it can be pulled down when the frame is running late. A retina
    // display asks for four times the pixels of a 1x one for the same window,
    // and a loaded rig with a convoy around it is the wrong moment to be paying
    // that in full.
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.pixelScale = 1;
    this.frameBudget = 1 / 55;   // seconds; below this we are comfortably at 60
    this._frameAvg = 1 / 60;
    this._settleFor = 0;

    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.scene = new Scene();
    // Far enough to see the country the route runs through. What used to make a
    // long draw distance expensive was that everything on the route was inside
    // it -- every tree, house and painted line, at any range. Those carry their
    // own cull distance now, so what is left out here is the coarse terrain that
    // makes the horizon, which is a few thousand triangles.
    this.camera = new PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.25, 9000);

    // --- Sky ---------------------------------------------------------------
    // Preetham atmospheric scattering. It also feeds the reflection probe, so
    // the chrome on the tractor reflects the same sky that is lighting it.
    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    const sky = this.sky.material.uniforms;
    sky.turbidity.value = 4.2;
    sky.rayleigh.value = 1.8;
    sky.mieCoefficient.value = 0.006;
    sky.mieDirectionalG.value = 0.82;
    this.scene.add(this.sky);

    // --- Lighting ----------------------------------------------------------
    this.sun = new DirectionalLight(0xfff4e2, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.05;
    const cam = this.sun.shadow.camera;
    cam.near = 1;
    cam.far = 260;
    this.shadowRadius = 48;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new HemisphereLight(0xbcd6ff, 0x5a4a38, 0.25);
    this.scene.add(this.hemi);

    this.pmrem = new PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    this.envRT = null;

    // Colours the reflection probe is built from. Updated by setTimeOfDay.
    this.probeZenith = new Color(0x2f6bc4);
    this.probeHorizon = new Color(0xbcd2e8);
    this.probeGround = new Color(0x4a4536);

    // Fog starts well beyond the rig so the load itself never goes hazy, and
    // reaches full density short of the far plane, so nothing ever pops out of
    // existence at the edge of the frustum -- it has already gone to haze.
    this.fogColor = new Color(0xa8bdd4);
    this.scene.fog = new Fog(this.fogColor, 700, 7000);

    this.setTimeOfDay(9.5);

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /**
   * @param hour 0-24. Drives sun position, colour, and the environment map.
   */
  setTimeOfDay(hour) {
    this.hour = hour;
    // Simple solar path: elevation peaks at noon, azimuth swings east to west.
    const t = (hour - 6) / 12;                 // 0 at sunrise, 1 at sunset
    const elevation = Math.sin(Math.PI * t) * 62;
    const azimuth = -50 + t * 130;

    const phi = MathUtils.degToRad(90 - elevation);
    const theta = MathUtils.degToRad(azimuth);
    this.sunDirection = new Vector3().setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDirection);

    const daylight = Math.max(0, Math.sin(Math.PI * t));
    this.sun.intensity = 0.25 + daylight * 2.3;
    // Warm the sun and the fog as it drops toward the horizon.
    const warmth = 1 - daylight;
    this.sun.color.setRGB(1, 0.96 - warmth * 0.22, 0.89 - warmth * 0.42);
    this.hemi.intensity = 0.10 + daylight * 0.30;

    this.fogColor.setRGB(
      0.42 + daylight * 0.26,
      0.50 + daylight * 0.26,
      0.60 + daylight * 0.24
    );
    this.scene.fog.color.copy(this.fogColor);
    this.renderer.toneMappingExposure = 0.62 + daylight * 0.34;

    // Probe colours track the sun: a deep blue zenith at midday warming to a
    // low-contrast amber wash near sunrise and sunset.
    this.probeZenith.setRGB(
      0.06 + warmth * 0.30,
      0.16 + warmth * 0.16,
      0.46 - warmth * 0.16
    ).multiplyScalar(0.25 + daylight * 0.95);
    this.probeHorizon.setRGB(
      0.55 + warmth * 0.35,
      0.62 + warmth * 0.02,
      0.76 - warmth * 0.30
    ).multiplyScalar(0.25 + daylight * 0.95);
    this.probeGround.setRGB(0.20, 0.18, 0.14).multiplyScalar(0.20 + daylight * 0.60);

    this.refreshEnvironment();
  }

  /**
   * Rebuilds the reflection probe.
   *
   * The probe is baked from a clamped analytic gradient rather than from the
   * Preetham sky itself. That shader raises intermediate values to a fractional
   * power, and near the horizon those values can go slightly negative -- one
   * NaN texel propagates through the whole PMREM mip chain and every PBR
   * material in the scene renders black. The gradient below is built from the
   * same sun direction and daylight factor, so it matches what you see without
   * being able to produce a NaN.
   */
  refreshEnvironment() {
    if (this.envRT) this.envRT.dispose();

    const probeScene = new Scene();
    const mat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: {
        sunDirection: { value: this.sunDirection.clone() },
        zenith: { value: new Color().copy(this.probeZenith) },
        horizon: { value: new Color().copy(this.probeHorizon) },
        groundColor: { value: new Color().copy(this.probeGround) },
        sunColor: { value: new Color().copy(this.sun.color) },
        sunIntensity: { value: this.sun.intensity },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform vec3 sunDirection;
        uniform vec3 zenith;
        uniform vec3 horizon;
        uniform vec3 groundColor;
        uniform vec3 sunColor;
        uniform float sunIntensity;

        void main() {
          vec3 d = normalize(vDir);
          float up = clamp(d.y, -1.0, 1.0);

          // Sky above, ground bounce below, softened across the horizon.
          float skyMix = smoothstep(-0.06, 0.30, up);
          vec3 col = mix(groundColor, mix(horizon, zenith, smoothstep(0.0, 0.75, up)), skyMix);

          // Broad sun glow, clamped so the probe stays in a sane range.
          float cosSun = clamp(dot(d, normalize(sunDirection)), 0.0, 1.0);
          col += sunColor * sunIntensity * 0.55 * pow(cosSun, 48.0);
          col += sunColor * sunIntensity * 0.10 * pow(cosSun, 6.0);

          gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
        }
      `,
    });

    const probe = new Mesh(new SphereGeometry(1, 32, 16), mat);
    probeScene.add(probe);
    this.envRT = this.pmrem.fromScene(probeScene, 0.02);
    this.scene.environment = this.envRT.texture;

    probe.geometry.dispose();
    mat.dispose();
  }

  /** Keeps the shadow box tight around the rig as it moves. */
  update(focus) {
    _target.copy(focus);
    this.sun.target.position.copy(_target);
    this.sun.position.copy(_target).addScaledVector(this.sunDirection, 140);

    const cam = this.sun.shadow.camera;
    const r = this.shadowRadius;
    if (cam.left !== -r) {
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.updateProjectionMatrix();
    }
    this.sun.target.updateMatrixWorld();
  }

  /**
   * Trades resolution for frame rate when the frame is running late.
   *
   * A dropped frame is far more visible than a softer image -- the whole
   * complaint about a simulator running badly is that the motion stutters, not
   * that the edges are not crisp. So the render target is scaled between full
   * resolution and half, following a smoothed frame time, and it only scales
   * back up after the frame has been comfortably inside budget for a while.
   * Without that hysteresis it oscillates: dropping the resolution makes the
   * frame fast, which puts it straight back up, which makes it slow again.
   *
   * @param dt seconds the last frame actually took
   */
  adaptResolution(dt) {
    if (!(dt > 0) || dt > 0.5) return;      // a tab coming back, not a slow frame
    this._frameAvg += (dt - this._frameAvg) * 0.1;

    const budget = this.frameBudget;
    let scale = this.pixelScale;
    if (this._frameAvg > budget * 1.25) {
      scale = Math.max(0.5, scale - 0.08);
      this._settleFor = 0;
    } else if (this._frameAvg < budget * 0.8) {
      this._settleFor += dt;
      if (this._settleFor > 2) scale = Math.min(1, scale + 0.04);
    } else {
      this._settleFor = 0;
    }

    if (Math.abs(scale - this.pixelScale) > 1e-3) {
      this.pixelScale = scale;
      this.renderer.setPixelRatio(this.maxPixelRatio * scale);
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
