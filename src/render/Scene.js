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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.25, 6000);

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
    // reaches full density around the far ridgeline.
    this.fogColor = new Color(0xa8bdd4);
    this.scene.fog = new Fog(this.fogColor, 900, 5200);

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

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
