import {
  Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, MeshBasicMaterial,
  BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry,
  DoubleSide, Color, TorusGeometry, CanvasTexture, Matrix4, Euler, Quaternion,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// -----------------------------------------------------------------------------
// Merging
// -----------------------------------------------------------------------------

const _m = new Matrix4();
const _quat = new Quaternion();
const _scale = new Vector3(1, 1, 1);

/**
 * Collects parts that share a material and emits one mesh for all of them.
 *
 * There are up to twenty-six vehicles on the road at once and each of them was
 * fifteen separate meshes -- two body panels, a windscreen, four lamps and eight
 * wheel halves. That is four hundred objects for the renderer to cull, sort and
 * submit, and again for the shadow map, to draw what the eye reads as a few cars
 * in the middle distance. Nothing in a car's body moves relative to the rest of
 * it, so the parts that share a material are welded into one buffer at build
 * time and drawn in a single call.
 *
 * Wheels stay separate, because they turn.
 */
export class Weld {
  constructor() {
    this.byMaterial = new Map();
  }

  /**
   * Adds a geometry at a transform. `geometry` is consumed -- it is cloned into
   * the buffer and the original is disposed once the weld is emitted.
   */
  add(geometry, material, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = {}) {
    _quat.setFromEuler(new Euler(rx, ry, rz));
    _m.compose(new Vector3(x, y, z), _quat, _scale);
    // Everything is de-indexed on the way in. Merging needs its inputs to agree
    // on whether they carry an index, and they do not: RoundedBoxGeometry is the
    // one primitive in three's set that comes back unindexed, and it is the one
    // nearly every body panel is made of.
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const g = source.clone().applyMatrix4(_m);
    if (source !== geometry) source.dispose();
    let list = this.byMaterial.get(material);
    if (!list) this.byMaterial.set(material, (list = []));
    list.push(g);
    return this;
  }

  /** Emits one mesh per material into `parent`. */
  build(parent, { castShadow = true, receiveShadow = true } = {}) {
    for (const [material, list] of this.byMaterial) {
      const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) for (const g of list) g.dispose();
      const mesh = new Mesh(geo, material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      parent.add(mesh);
    }
    return parent;
  }
}

// -----------------------------------------------------------------------------
// Shared materials
// -----------------------------------------------------------------------------

export const materials = {
  paintRed: new MeshPhysicalMaterial({
    color: 0x8f1c1c, metalness: 0.55, roughness: 0.32, clearcoat: 0.85, clearcoatRoughness: 0.12,
  }),
  paintWhite: new MeshPhysicalMaterial({
    color: 0xe8e8e6, metalness: 0.4, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15,
  }),
  paintBlack: new MeshPhysicalMaterial({
    color: 0x14161a, metalness: 0.5, roughness: 0.38, clearcoat: 0.7,
  }),
  chrome: new MeshStandardMaterial({ color: 0xd8dde2, metalness: 1.0, roughness: 0.10 }),
  darkMetal: new MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.85, roughness: 0.45 }),
  frame: new MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.7, roughness: 0.55 }),
  rubber: new MeshStandardMaterial({ color: 0x121316, metalness: 0.0, roughness: 0.92 }),
  rim: new MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.95, roughness: 0.24 }),
  glass: new MeshPhysicalMaterial({
    color: 0x0e1418, metalness: 0.1, roughness: 0.06, transmission: 0.55,
    thickness: 0.1, transparent: true, opacity: 0.75,
  }),
  cargoSteel: new MeshStandardMaterial({ color: 0x4d5359, metalness: 0.75, roughness: 0.55 }),
  cargoAccent: new MeshStandardMaterial({ color: 0x7d838a, metalness: 0.7, roughness: 0.4 }),
  deck: new MeshStandardMaterial({ color: 0x4a4136, metalness: 0.2, roughness: 0.85 }),
  policeWhite: new MeshPhysicalMaterial({
    color: 0xf0f1f3, metalness: 0.35, roughness: 0.3, clearcoat: 0.85,
  }),
  policeBlack: new MeshPhysicalMaterial({
    color: 0x1a1c20, metalness: 0.45, roughness: 0.34, clearcoat: 0.8,
  }),
  pilotYellow: new MeshPhysicalMaterial({
    color: 0xe8b200, metalness: 0.4, roughness: 0.32, clearcoat: 0.85,
  }),
  bannerBlack: new MeshBasicMaterial({ color: 0x101010, side: DoubleSide }),
};

// Emissive lamp materials, toggled by the light controllers.
export function lampMaterial(color, intensity = 3) {
  return new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity) });
}

// Box geometries are shared between every part that wants the same size. A road
// full of traffic is a lot of identical body panels, and each one used to be its
// own buffer.
const _boxCache = new Map();

/**
 * The geometry behind a body panel.
 *
 * A rounded box at two segments of corner detail is **three hundred** triangles
 * -- twenty-five times a plain box -- and almost every part of every vehicle in
 * this project is one. Across the rig, four escorts and a road full of traffic
 * that came to three hundred thousand triangles a frame, drawn twice because
 * most of it casts a shadow, for corner fillets a few centimetres across.
 *
 * One segment carries the same read at a third of the cost, and below about
 * three centimetres of radius the rounding is not resolvable at any distance the
 * part is ever seen from, so it is dropped entirely.
 */
function boxGeometry(w, h, d, radius) {
  const r = Math.min(radius, Math.min(w, h, d) * 0.45);
  const key = `${w},${h},${d},${r > 0.035 ? r.toFixed(3) : 0}`;
  let geo = _boxCache.get(key);
  if (!geo) {
    geo = r > 0.035 ? new RoundedBoxGeometry(w, h, d, 1, r) : new BoxGeometry(w, h, d);
    _boxCache.set(key, geo);
  }
  return geo;
}

function box(w, h, d, material, radius = 0.03) {
  const mesh = new Mesh(boxGeometry(w, h, d, radius), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function place(mesh, x, y, z) {
  mesh.position.set(x, y, z);
  return mesh;
}

// -----------------------------------------------------------------------------
// Wheels
// -----------------------------------------------------------------------------

/**
 * A truck wheel. `dual` builds the paired tires used on drive and trailer
 * axles, which is both visually distinctive and the reason those positions
 * carry so much more load than the steer axle.
 */
export function createWheel(radius = 0.512, width = 0.30, dual = false, positions = [0]) {
  const group = new Group();
  const weld = new Weld();
  // Fourteen sides on a tire and ten on a hub: at the size a wheel is ever seen,
  // that silhouette is indistinguishable from the twenty-two it used to have,
  // and there are around a hundred and twenty wheels on the road at once.
  const tireGeo = new CylinderGeometry(radius, radius, width, 14);
  const hubGeo = new CylinderGeometry(radius * 0.56, radius * 0.56, width + 0.012, 10);

  for (const at of positions) {
    const offsets = dual ? [at - width * 0.56, at + width * 0.56] : [at];
    for (const x of offsets) {
      weld.add(tireGeo, materials.rubber, { x, rz: Math.PI / 2 });
      weld.add(hubGeo, materials.rim, { x, rz: Math.PI / 2 });
    }
  }
  tireGeo.dispose();
  hubGeo.dispose();
  return weld.build(group);
}

// -----------------------------------------------------------------------------
// Tractor
// -----------------------------------------------------------------------------

/**
 * A conventional long-nose tractor, the shape heavy haul work almost always
 * uses: the long hood is there because the engine and the cooling package under
 * it are much bigger than a highway truck's.
 *
 * Geometry is in the tractor body's local frame, so the origin is its centre of
 * mass and +Z is forward.
 */
export function createTractor() {
  const g = new Group();
  const paint = materials.paintRed;
  const w = new Weld();

  // Frame rails
  for (const side of [-0.45, 0.45]) {
    w.add(boxGeometry(0.16, 0.26, 7.0, 0.02), materials.frame, { x: side, y: -0.62, z: -0.3 });
  }

  // Hood and cab
  w.add(boxGeometry(2.30, 1.02, 2.55, 0.10), paint, { y: 0.28, z: 2.05 });
  w.add(boxGeometry(1.92, 0.86, 0.10, 0.03), materials.chrome, { y: 0.26, z: 3.32 });
  w.add(boxGeometry(2.46, 0.34, 0.20, 0.05), materials.chrome, { y: -0.28, z: 3.36 });
  w.add(boxGeometry(2.44, 1.72, 2.30, 0.10), paint, { y: 0.66, z: 0.35 });

  // Sleeper
  w.add(boxGeometry(2.44, 1.78, 1.85, 0.08), paint, { y: 0.70, z: -1.30 });

  // Glass
  w.add(boxGeometry(2.06, 0.86, 0.06, 0.02), materials.glass, { y: 1.06, z: 1.52, rx: -0.20 });
  for (const side of [-1, 1]) {
    w.add(boxGeometry(0.06, 0.62, 1.10, 0.02), materials.glass, { x: side * 1.21, y: 1.02, z: 0.42 });
  }

  // Exhaust stacks, air cleaners and fuel tanks
  const stackGeo = new CylinderGeometry(0.085, 0.085, 2.5, 10);
  const cleanerGeo = new CylinderGeometry(0.14, 0.14, 1.15, 10);
  const tankGeo = new CylinderGeometry(0.36, 0.36, 1.5, 12);
  for (const side of [-1, 1]) {
    w.add(stackGeo, materials.chrome, { x: side * 1.28, y: 1.15, z: -0.52 });
    w.add(cleanerGeo, materials.chrome, { x: side * 1.24, y: 0.52, z: 0.95 });
    w.add(tankGeo, materials.chrome, { x: side * 1.16, y: -0.42, z: -0.35, rz: Math.PI / 2 });
  }
  for (const geo of [stackGeo, cleanerGeo, tankGeo]) geo.dispose();

  // Fifth wheel plate, at the coupling height the physics uses.
  w.add(boxGeometry(1.10, 0.10, 1.00, 0.03), materials.darkMetal, { y: 0.10, z: -2.10, rx: -0.05 });

  // Mirrors
  for (const side of [-1, 1]) {
    w.add(boxGeometry(0.06, 0.52, 0.20, 0.02), materials.darkMetal, { x: side * 1.42, y: 1.10, z: 1.22 });
  }

  // Lights. One material and one mesh per lamp colour: nothing on the tractor
  // switches an individual bulb, so a material each bought two draw calls and
  // five more.
  const headMat = lampMaterial(0xfff2d0, 1);
  for (const side of [-1, 1]) {
    w.add(boxGeometry(0.34, 0.20, 0.06, 0), headMat, { x: side * 0.86, y: 0.18, z: 3.36 });
  }
  const markerMat = lampMaterial(0xffa63a, 1);
  for (const x of [-0.72, -0.36, 0, 0.36, 0.72]) {
    w.add(boxGeometry(0.09, 0.05, 0.05, 0), markerMat, { x, y: 1.55, z: 1.30 });
  }

  return w.build(g);
}

// -----------------------------------------------------------------------------
// Jeep dolly
// -----------------------------------------------------------------------------

/** The two-axle jeep that spreads load between the tractor and the lowboy. */
export function createJeep() {
  const g = new Group();
  const w = new Weld();
  for (const side of [-0.52, 0.52]) {
    w.add(boxGeometry(0.18, 0.30, 4.6, 0.02), materials.frame, { x: side, y: -0.30, z: -0.6 });
  }
  w.add(boxGeometry(1.5, 0.16, 2.2, 0.02), materials.frame, { y: -0.10, z: -0.9 });

  // Kingpin plate up front, fifth wheel at the rear.
  w.add(boxGeometry(1.0, 0.10, 0.9, 0.03), materials.darkMetal, { y: 0.28, z: 2.10 });
  w.add(boxGeometry(1.05, 0.10, 0.95, 0.03), materials.darkMetal, { y: 0.29, z: -0.30 });

  // Gooseneck reach beam
  w.add(boxGeometry(0.5, 0.34, 2.6, 0.03), materials.frame, { y: 0.05, z: 0.95 });
  return w.build(g);
}

// -----------------------------------------------------------------------------
// Lowboy and load
// -----------------------------------------------------------------------------

/**
 * A four-axle lowboy with a dropped well deck, plus the load sitting on it.
 *
 * The deck sits about 0.55 m off the road, which is the whole point of the
 * trailer: it buys back nearly a metre of vertical clearance so a tall load can
 * still get under bridges.
 */
export function createLowboy(cargo, comHeight) {
  const g = new Group();
  const y = (world) => world - comHeight;   // world height -> local
  const w = new Weld();

  // Gooseneck: rises from the deck up to the coupling height.
  w.add(boxGeometry(1.6, 0.85, 2.6, 0.05), materials.frame, { y: y(1.05), z: 5.5, rx: 0.16 });
  w.add(boxGeometry(1.3, 0.55, 1.5, 0.04), materials.frame, { y: y(1.16), z: 6.5 });

  // Well deck
  const deckY = y(0.55);
  w.add(boxGeometry(3.05, 0.22, 9.4, 0.02), materials.deck, { y: deckY, z: 0.4 });
  for (const side of [-1.32, 1.32]) {
    w.add(boxGeometry(0.28, 0.46, 9.8, 0.03), materials.frame, { x: side, y: deckY - 0.10, z: 0.4 });
  }

  // Rear axle bogie frame
  w.add(boxGeometry(2.9, 0.5, 5.4, 0.04), materials.frame, { y: y(0.95), z: -6.1 });

  // Outriggers, which is how the deck gets wide enough for an oversize load.
  for (const z of [3.4, 1.2, -1.0, -3.0]) {
    w.add(boxGeometry(3.9, 0.10, 0.22, 0.02), materials.frame, { y: deckY + 0.13, z });
  }

  // --- The load ----------------------------------------------------------
  const cw = cargo.size.x;
  const ch = cargo.size.y;
  const cd = cargo.size.z;
  const cargoY = y(cargo.centerHeight);
  const cargoZ = 0.4;

  w.add(boxGeometry(cw, ch, cd, 0.06), materials.cargoSteel, { y: cargoY, z: cargoZ });

  // Transformer detailing: radiator banks down the sides, bushings on top.
  for (const side of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      w.add(boxGeometry(0.16, ch * 0.62, 0.34, 0.02), materials.cargoAccent, {
        x: side * (cw / 2 + 0.10), y: cargoY - ch * 0.05, z: cargoZ + i * (cd / 6),
      });
    }
  }
  const bushingGeo = new ConeGeometry(0.20, 0.85, 8);
  for (const x of [-cw * 0.28, 0, cw * 0.28]) {
    w.add(bushingGeo, materials.cargoAccent, { x, y: cargoY + ch / 2 + 0.42, z: cargoZ + cd * 0.22 });
  }
  bushingGeo.dispose();

  // Lifting lugs
  const lugGeo = new TorusGeometry(0.14, 0.035, 5, 9);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      w.add(lugGeo, materials.darkMetal, {
        x: sx * cw * 0.38, y: cargoY + ch / 2 + 0.10, z: cargoZ + sz * cd * 0.36,
        ry: Math.PI / 2,
      });
    }
  }
  lugGeo.dispose();

  // Chain tie-downs from the deck up over the load.
  const chainGeo = new CylinderGeometry(0.028, 0.028, ch * 0.95, 5);
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      w.add(chainGeo, materials.darkMetal, {
        x: sx * (cw / 2 + 0.22), y: cargoY - ch * 0.05, z: 0.4 + sz * cd * 0.34,
        rz: sx * 0.34,
      });
    }
  }
  chainGeo.dispose();

  // Flags on the corners.
  const flagMat = new MeshBasicMaterial({ color: 0xd8232a, side: DoubleSide });
  const flagGeo = new PlaneGeometry(0.45, 0.45);
  for (const sx of [-1, 1]) {
    w.add(flagGeo, flagMat, {
      x: sx * (cw / 2 + 0.28), y: y(cargo.centerHeight + ch * 0.55), z: -cd * 0.42,
      ry: Math.PI / 2,
    });
  }
  flagGeo.dispose();

  // Amber clearance lights along the outriggers and across the tail.
  const markerMat = lampMaterial(0xffa63a, 1);
  for (const sx of [-1, 1]) {
    for (const z of [3.6, 0.4, -3.2, -7.4]) {
      w.add(boxGeometry(0.10, 0.06, 0.06, 0), markerMat, { x: sx * 1.98, y: deckY + 0.22, z });
    }
  }
  w.build(g);

  // OVERSIZE LOAD banner across the back. Its own texture, so its own mesh.
  const banner = makeBanner('OVERSIZE LOAD', 3.4, 0.62);
  g.add(place(banner, 0, y(1.9), -8.9));
  banner.rotation.y = Math.PI;

  const tailMat = lampMaterial(0xff2a1a, 0.6);
  const tails = new Weld();
  for (const sx of [-1, 1]) {
    tails.add(boxGeometry(0.22, 0.14, 0.06, 0), tailMat, { x: sx * 1.2, y: y(1.0), z: -8.95 });
  }
  const tailGroup = new Group();
  tails.build(tailGroup);
  g.add(tailGroup);
  g.userData.tailLights = tailGroup.children;

  return g;
}

/** A canvas-drawn banner, used for OVERSIZE LOAD signage. */
export function makeBanner(text, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.round((height / width) * 1024);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f2c200';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  ctx.font = `bold ${Math.round(canvas.height * 0.62)}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height * 0.54);

  const tex = new CanvasTexture(canvas);
  const mat = new MeshBasicMaterial({ map: tex, side: DoubleSide });
  return new Mesh(new PlaneGeometry(width, height), mat);
}

// -----------------------------------------------------------------------------
// Escort and traffic vehicles
// -----------------------------------------------------------------------------

function carBody(bodyMat, roofMat = bodyMat) {
  const g = new Group();
  const weld = new Weld();
  weld.add(boxGeometry(1.86, 0.62, 4.6, 0.16), bodyMat, { y: 0.42 });
  weld.add(boxGeometry(1.70, 0.54, 2.30, 0.18), roofMat, { y: 0.96, z: -0.18 });
  weld.add(boxGeometry(1.60, 0.40, 2.0, 0.10), materials.glass, { y: 0.98, z: -0.16 });

  const headMat = lampMaterial(0xfff2d0, 1);
  for (const sx of [-1, 1]) {
    weld.add(boxGeometry(0.34, 0.14, 0.06, 0), headMat, { x: sx * 0.62, y: 0.50, z: 2.30 });
  }
  weld.build(g);

  // Both tail lights share one material and one mesh. They are only ever set
  // together -- brake, hazard or dim is a state of the car, not of the lamp --
  // so a material each was two draw calls buying nothing.
  const tailMat = lampMaterial(0xff2a1a, 0.5);
  const tails = new Weld();
  for (const sx of [-1, 1]) {
    tails.add(boxGeometry(0.30, 0.14, 0.06, 0), tailMat, { x: sx * 0.62, y: 0.52, z: -2.30 });
  }
  const tailGroup = new Group();
  tails.build(tailGroup);
  g.add(tailGroup);
  g.userData.tailLights = tailGroup.children;
  return g;
}

/**
 * Adds the road wheels and records them so the vehicle controllers can roll and
 * steer them. A car whose wheels never turn reads as a box being slid along the
 * road no matter how good the body is.
 */
function wheelsForCar(g, { radius = 0.34, width = 0.22, front = 1.42, rear = -1.42, track = 0.86 } = {}) {
  const wheels = [];
  const steered = [];

  // The rear pair is one object. Both wheels turn about the same axle line at
  // the same rate and neither ever steers, so welding them is exact rather than
  // an approximation -- and it is two fewer draw calls per car. The front pair
  // stays split, because each of those turns about its own kingpin.
  for (const sx of [-1, 1]) {
    const w = createWheel(radius, width, false);
    w.position.set(sx * track, radius, front);
    g.add(w);
    wheels.push(w);
    steered.push(w);
  }
  const axle = createWheel(radius, width, false, [-track, track]);
  axle.position.set(0, radius, rear);
  g.add(axle);
  wheels.push(axle);

  g.userData.wheels = wheels;
  g.userData.steeredWheels = steered;
  g.userData.wheelRadius = radius;
  return g;
}

/** Police cruiser with a roof light bar. */
export function createPoliceCar() {
  const g = carBody(materials.policeWhite, materials.policeWhite);
  wheelsForCar(g);

  // Door panel
  const trim = new Weld();
  for (const sx of [-1, 1]) {
    trim.add(boxGeometry(0.03, 0.36, 1.5, 0.01), materials.policeBlack, { x: sx * 0.94, y: 0.44, z: -0.1 });
  }
  trim.build(g);

  // Light bar. The two reds are one mesh and the two blues another, since the
  // alternating pattern switches them as pairs.
  const bar = new Group();
  new Weld().add(boxGeometry(1.30, 0.10, 0.26, 0.03), materials.darkMetal, {}).build(bar);

  const redMat = lampMaterial(0xff1408, 1);
  const blueMat = lampMaterial(0x2050ff, 1);
  const redWeld = new Weld();
  const blueWeld = new Weld();
  for (let i = 0; i < 4; i++) {
    const x = -0.48 + i * 0.32;
    const isRed = i < 2;
    (isRed ? redWeld : blueWeld)
      .add(boxGeometry(0.28, 0.11, 0.22, 0), isRed ? redMat : blueMat, { x, y: 0.02 });
  }
  const redGroup = new Group();
  const blueGroup = new Group();
  redWeld.build(redGroup);
  blueWeld.build(blueGroup);
  bar.add(redGroup, blueGroup);
  bar.position.set(0, 1.28, -0.15);
  g.add(bar);

  g.userData.beacons = { reds: redGroup.children, blues: blueGroup.children };
  return g;
}

/** Pilot car: amber beacon, OVERSIZE LOAD banner, and a height pole. */
export function createPilotCar(poleHeight = 5.0) {
  const g = carBody(materials.pilotYellow, materials.pilotYellow);
  wheelsForCar(g);

  const banner = makeBanner('OVERSIZE LOAD', 1.7, 0.34);
  g.add(place(banner, 0, 1.42, -0.2));
  const banner2 = makeBanner('OVERSIZE LOAD', 1.7, 0.34);
  banner2.rotation.y = Math.PI;
  g.add(place(banner2, 0, 1.42, -0.24));

  // Amber beacons, flashed together and so built as one mesh.
  const amberMat = lampMaterial(0xffa000, 1);
  const amberGeo = new CylinderGeometry(0.10, 0.11, 0.14, 10);
  const ambers = new Weld();
  for (const sx of [-1, 1]) ambers.add(amberGeo, amberMat, { x: sx * 0.45, y: 1.30, z: -0.6 });
  amberGeo.dispose();
  const amberGroup = new Group();
  ambers.build(amberGroup);
  g.add(amberGroup);

  // Height pole: a fibreglass whip set just above the load. If it strikes, the
  // load would have struck.
  const pole = new Group();
  const mast = new Mesh(new CylinderGeometry(0.035, 0.045, poleHeight, 6), materials.darkMetal);
  mast.position.y = poleHeight / 2;
  pole.add(mast);
  const cross = new Mesh(new CylinderGeometry(0.028, 0.028, 1.1, 5), new MeshBasicMaterial({ color: 0xff5a00 }));
  cross.rotation.z = Math.PI / 2;
  cross.position.y = poleHeight;
  pole.add(cross);
  pole.position.set(0, 0.7, 2.15);
  g.add(pole);

  g.userData.beacons = { ambers: amberGroup.children };
  g.userData.pole = pole;
  return g;
}

const TRAFFIC_COLORS = [0x2c3e6b, 0x8a2a2a, 0x2f4f3a, 0xd8d8d4, 0x3a3a3e, 0x6b5330, 0x1f5f6b];

/** Ambient traffic: a passenger car or a straight truck. */
export function createTrafficVehicle(kind = 'car', seed = 0) {
  if (kind === 'truck') {
    const g = new Group();
    const weld = new Weld();
    weld.add(boxGeometry(2.4, 1.5, 5.4, 0.10), materials.paintWhite, { y: 1.35, z: -3.2 });
    weld.add(boxGeometry(2.3, 1.5, 2.1, 0.12), materials.paintWhite, { y: 1.30, z: 1.0 });
    weld.add(boxGeometry(2.0, 0.7, 0.08, 0.03), materials.glass, { y: 1.62, z: 2.02 });
    weld.build(g);

    const wheels = [];
    const steered = [];
    for (const sx of [-1, 1]) {
      const w = createWheel(0.46, 0.26, false);
      w.position.set(sx * 0.94, 0.46, 1.4);
      g.add(w);
      wheels.push(w);
      steered.push(w);
    }
    for (const sz of [-1.6, -3.0]) {
      const axle = createWheel(0.46, 0.26, true, [-0.94, 0.94]);
      axle.position.set(0, 0.46, sz);
      g.add(axle);
      wheels.push(axle);
    }
    g.userData.wheels = wheels;
    g.userData.steeredWheels = steered;
    g.userData.wheelRadius = 0.46;

    const tailMat = lampMaterial(0xff2a1a, 0.5);
    const tails = new Weld();
    for (const sx of [-1, 1]) {
      tails.add(boxGeometry(0.26, 0.16, 0.06, 0), tailMat, { x: sx * 1.0, y: 0.9, z: -5.92 });
    }
    const tailGroup = new Group();
    tails.build(tailGroup);
    g.add(tailGroup);
    g.userData.tailLights = tailGroup.children;
    return g;
  }

  const color = TRAFFIC_COLORS[Math.floor(seed * TRAFFIC_COLORS.length) % TRAFFIC_COLORS.length];
  const mat = new MeshPhysicalMaterial({
    color, metalness: 0.5, roughness: 0.34, clearcoat: 0.8, clearcoatRoughness: 0.14,
  });
  const g = carBody(mat, mat);
  wheelsForCar(g);
  return g;
}
