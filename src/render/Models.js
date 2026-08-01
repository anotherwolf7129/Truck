import {
  Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, MeshBasicMaterial,
  BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry,
  DoubleSide, Color, TorusGeometry, CanvasTexture,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

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

function box(w, h, d, material, radius = 0.03) {
  const geo = radius > 0
    ? new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, Math.min(w, h, d) * 0.45))
    : new BoxGeometry(w, h, d);
  const mesh = new Mesh(geo, material);
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
export function createWheel(radius = 0.512, width = 0.30, dual = false) {
  const group = new Group();
  const build = (offset) => {
    const tire = new Mesh(new CylinderGeometry(radius, radius, width, 22), materials.rubber);
    tire.rotation.z = Math.PI / 2;
    tire.position.x = offset;
    tire.castShadow = true;
    tire.receiveShadow = true;
    group.add(tire);

    const hub = new Mesh(
      new CylinderGeometry(radius * 0.56, radius * 0.56, width + 0.012, 16),
      materials.rim
    );
    hub.rotation.z = Math.PI / 2;
    hub.position.x = offset;
    group.add(hub);
  };

  if (dual) {
    build(-width * 0.56);
    build(width * 0.56);
  } else {
    build(0);
  }
  return group;
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

  // Frame rails
  for (const side of [-0.45, 0.45]) {
    g.add(place(box(0.16, 0.26, 7.0, materials.frame, 0.02), side, -0.62, -0.3));
  }

  // Hood and cab
  const hood = box(2.30, 1.02, 2.55, paint, 0.10);
  g.add(place(hood, 0, 0.28, 2.05));
  const grille = box(1.92, 0.86, 0.10, materials.chrome, 0.03);
  g.add(place(grille, 0, 0.26, 3.32));
  const bumper = box(2.46, 0.34, 0.20, materials.chrome, 0.05);
  g.add(place(bumper, 0, -0.28, 3.36));

  const cab = box(2.44, 1.72, 2.30, paint, 0.10);
  g.add(place(cab, 0, 0.66, 0.35));

  // Sleeper
  const sleeper = box(2.44, 1.78, 1.85, paint, 0.08);
  g.add(place(sleeper, 0, 0.70, -1.30));

  // Glass
  const windshield = box(2.06, 0.86, 0.06, materials.glass, 0.02);
  windshield.rotation.x = -0.20;
  g.add(place(windshield, 0, 1.06, 1.52));
  for (const side of [-1, 1]) {
    const sideGlass = box(0.06, 0.62, 1.10, materials.glass, 0.02);
    g.add(place(sideGlass, side * 1.21, 1.02, 0.42));
  }

  // Exhaust stacks and air cleaners
  for (const side of [-1, 1]) {
    const stack = new Mesh(new CylinderGeometry(0.085, 0.085, 2.5, 14), materials.chrome);
    g.add(place(stack, side * 1.28, 1.15, -0.52));
    const cleaner = new Mesh(new CylinderGeometry(0.14, 0.14, 1.15, 14), materials.chrome);
    g.add(place(cleaner, side * 1.24, 0.52, 0.95));
  }

  // Fuel tanks
  for (const side of [-1, 1]) {
    const tank = new Mesh(new CylinderGeometry(0.36, 0.36, 1.5, 18), materials.chrome);
    tank.rotation.z = Math.PI / 2;
    g.add(place(tank, side * 1.16, -0.42, -0.35));
  }

  // Fifth wheel plate, at the coupling height the physics uses.
  const plate = box(1.10, 0.10, 1.00, materials.darkMetal, 0.03);
  plate.rotation.x = -0.05;
  g.add(place(plate, 0, 0.10, -2.10));

  // Mirrors
  for (const side of [-1, 1]) {
    g.add(place(box(0.06, 0.52, 0.20, materials.darkMetal, 0.02), side * 1.42, 1.10, 1.22));
  }

  // Lights
  const headlights = [];
  for (const side of [-1, 1]) {
    const hl = new Mesh(new BoxGeometry(0.34, 0.20, 0.06), lampMaterial(0xfff2d0, 1));
    place(hl, side * 0.86, 0.18, 3.36);
    g.add(hl);
    headlights.push(hl);
  }
  const markers = [];
  for (const x of [-0.72, -0.36, 0, 0.36, 0.72]) {
    const m = new Mesh(new BoxGeometry(0.09, 0.05, 0.05), lampMaterial(0xffa63a, 1));
    place(m, x, 1.55, 1.30);
    g.add(m);
    markers.push(m);
  }

  g.userData.headlights = headlights;
  g.userData.markers = markers;
  return g;
}

// -----------------------------------------------------------------------------
// Jeep dolly
// -----------------------------------------------------------------------------

/** The two-axle jeep that spreads load between the tractor and the lowboy. */
export function createJeep() {
  const g = new Group();
  for (const side of [-0.52, 0.52]) {
    g.add(place(box(0.18, 0.30, 4.6, materials.frame, 0.02), side, -0.30, -0.6));
  }
  g.add(place(box(1.5, 0.16, 2.2, materials.frame, 0.02), 0, -0.10, -0.9));

  // Kingpin plate up front, fifth wheel at the rear.
  g.add(place(box(1.0, 0.10, 0.9, materials.darkMetal, 0.03), 0, 0.28, 2.10));
  g.add(place(box(1.05, 0.10, 0.95, materials.darkMetal, 0.03), 0, 0.29, -0.30));

  // Gooseneck reach beam
  g.add(place(box(0.5, 0.34, 2.6, materials.frame, 0.03), 0, 0.05, 0.95));
  return g;
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

  // Gooseneck: rises from the deck up to the coupling height.
  const neck = box(1.6, 0.85, 2.6, materials.frame, 0.05);
  neck.rotation.x = 0.16;
  g.add(place(neck, 0, y(1.05), 5.5));
  g.add(place(box(1.3, 0.55, 1.5, materials.frame, 0.04), 0, y(1.16), 6.5));

  // Well deck
  const deckY = y(0.55);
  g.add(place(box(3.05, 0.22, 9.4, materials.deck, 0.02), 0, deckY, 0.4));
  for (const side of [-1.32, 1.32]) {
    g.add(place(box(0.28, 0.46, 9.8, materials.frame, 0.03), side, deckY - 0.10, 0.4));
  }

  // Rear axle bogie frame
  g.add(place(box(2.9, 0.5, 5.4, materials.frame, 0.04), 0, y(0.95), -6.1));

  // Outriggers, which is how the deck gets wide enough for an oversize load.
  for (const z of [3.4, 1.2, -1.0, -3.0]) {
    g.add(place(box(3.9, 0.10, 0.22, materials.frame, 0.02), 0, deckY + 0.13, z));
  }

  // --- The load ----------------------------------------------------------
  const cargoGroup = new Group();
  const cw = cargo.size.x;
  const ch = cargo.size.y;
  const cd = cargo.size.z;

  const bodyMesh = box(cw, ch, cd, materials.cargoSteel, 0.06);
  cargoGroup.add(place(bodyMesh, 0, 0, 0));

  // Transformer detailing: radiator banks down the sides, bushings on top.
  for (const side of [-1, 1]) {
    for (let i = -2; i <= 2; i++) {
      cargoGroup.add(place(
        box(0.16, ch * 0.62, 0.34, materials.cargoAccent, 0.02),
        side * (cw / 2 + 0.10), -ch * 0.05, i * (cd / 6)
      ));
    }
  }
  for (const x of [-cw * 0.28, 0, cw * 0.28]) {
    const bushing = new Mesh(new ConeGeometry(0.20, 0.85, 12), materials.cargoAccent);
    cargoGroup.add(place(bushing, x, ch / 2 + 0.42, cd * 0.22));
  }
  // Lifting lugs
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lug = new Mesh(new TorusGeometry(0.14, 0.035, 8, 14), materials.darkMetal);
      lug.rotation.y = Math.PI / 2;
      cargoGroup.add(place(lug, sx * cw * 0.38, ch / 2 + 0.10, sz * cd * 0.36));
    }
  }

  cargoGroup.position.set(0, y(cargo.centerHeight), 0.4);
  cargoGroup.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  g.add(cargoGroup);

  // Chain tie-downs from the deck up over the load.
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const chain = new Mesh(
        new CylinderGeometry(0.028, 0.028, ch * 0.95, 6),
        materials.darkMetal
      );
      chain.rotation.z = sx * 0.34;
      chain.position.set(
        sx * (cw / 2 + 0.22),
        y(cargo.centerHeight) - ch * 0.05,
        0.4 + sz * cd * 0.34
      );
      g.add(chain);
    }
  }

  // OVERSIZE LOAD banner across the back, plus flags on the corners.
  const banner = makeBanner('OVERSIZE LOAD', 3.4, 0.62);
  g.add(place(banner, 0, y(1.9), -8.9));
  banner.rotation.y = Math.PI;

  for (const sx of [-1, 1]) {
    const flag = new Mesh(new PlaneGeometry(0.45, 0.45), new MeshBasicMaterial({
      color: 0xd8232a, side: DoubleSide,
    }));
    flag.rotation.y = Math.PI / 2;
    g.add(place(flag, sx * (cw / 2 + 0.28), y(cargo.centerHeight + ch * 0.55), -cd * 0.42));
  }

  g.userData.markers = [];
  // Amber clearance lights along the outriggers and across the tail.
  for (const sx of [-1, 1]) {
    for (const z of [3.6, 0.4, -3.2, -7.4]) {
      const m = new Mesh(new BoxGeometry(0.10, 0.06, 0.06), lampMaterial(0xffa63a, 1));
      place(m, sx * 1.98, deckY + 0.22, z);
      g.add(m);
      g.userData.markers.push(m);
    }
  }
  g.userData.tailLights = [];
  for (const sx of [-1, 1]) {
    const t = new Mesh(new BoxGeometry(0.22, 0.14, 0.06), lampMaterial(0xff2a1a, 0.6));
    place(t, sx * 1.2, y(1.0), -8.95);
    g.add(t);
    g.userData.tailLights.push(t);
  }

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
  g.add(place(box(1.86, 0.62, 4.6, bodyMat, 0.16), 0, 0.42, 0));
  g.add(place(box(1.70, 0.54, 2.30, roofMat, 0.18), 0, 0.96, -0.18));
  g.add(place(box(1.60, 0.40, 2.0, materials.glass, 0.10), 0, 0.98, -0.16));

  for (const sx of [-1, 1]) {
    const hl = new Mesh(new BoxGeometry(0.34, 0.14, 0.06), lampMaterial(0xfff2d0, 1));
    place(hl, sx * 0.62, 0.50, 2.30);
    g.add(hl);
    const tl = new Mesh(new BoxGeometry(0.30, 0.14, 0.06), lampMaterial(0xff2a1a, 0.5));
    place(tl, sx * 0.62, 0.52, -2.30);
    g.add(tl);
  }
  return g;
}

function wheelsForCar(g) {
  for (const sx of [-1, 1]) {
    for (const sz of [1.42, -1.42]) {
      const w = createWheel(0.34, 0.22, false);
      w.position.set(sx * 0.86, 0.34, sz);
      g.add(w);
    }
  }
}

/** Police cruiser with a roof light bar. */
export function createPoliceCar() {
  const g = carBody(materials.policeWhite, materials.policeWhite);
  wheelsForCar(g);

  // Door panel
  for (const sx of [-1, 1]) {
    g.add(place(box(0.03, 0.36, 1.5, materials.policeBlack, 0.01), sx * 0.94, 0.44, -0.1));
  }

  // Light bar
  const bar = new Group();
  bar.add(place(box(1.30, 0.10, 0.26, materials.darkMetal, 0.03), 0, 0, 0));
  const reds = [];
  const blues = [];
  for (let i = 0; i < 4; i++) {
    const x = -0.48 + i * 0.32;
    const isRed = i < 2;
    const lamp = new Mesh(
      new BoxGeometry(0.28, 0.11, 0.22),
      lampMaterial(isRed ? 0xff1408 : 0x2050ff, 1)
    );
    lamp.position.set(x, 0.02, 0);
    bar.add(lamp);
    (isRed ? reds : blues).push(lamp);
  }
  bar.position.set(0, 1.28, -0.15);
  g.add(bar);

  g.userData.beacons = { reds, blues };
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

  // Amber beacons
  const beacons = [];
  for (const sx of [-1, 1]) {
    const b = new Mesh(new CylinderGeometry(0.10, 0.11, 0.14, 12), lampMaterial(0xffa000, 1));
    place(b, sx * 0.45, 1.30, -0.6);
    g.add(b);
    beacons.push(b);
  }

  // Height pole: a fibreglass whip set just above the load. If it strikes, the
  // load would have struck.
  const pole = new Group();
  const mast = new Mesh(new CylinderGeometry(0.035, 0.045, poleHeight, 8), materials.darkMetal);
  mast.position.y = poleHeight / 2;
  pole.add(mast);
  const cross = new Mesh(new CylinderGeometry(0.028, 0.028, 1.1, 6), new MeshBasicMaterial({ color: 0xff5a00 }));
  cross.rotation.z = Math.PI / 2;
  cross.position.y = poleHeight;
  pole.add(cross);
  pole.position.set(0, 0.7, 2.15);
  g.add(pole);

  g.userData.beacons = { ambers: beacons };
  g.userData.pole = pole;
  return g;
}

const TRAFFIC_COLORS = [0x2c3e6b, 0x8a2a2a, 0x2f4f3a, 0xd8d8d4, 0x3a3a3e, 0x6b5330, 0x1f5f6b];

/** Ambient traffic: a passenger car or a straight truck. */
export function createTrafficVehicle(kind = 'car', seed = 0) {
  if (kind === 'truck') {
    const g = new Group();
    g.add(place(box(2.4, 1.5, 5.4, materials.paintWhite, 0.10), 0, 1.35, -3.2));
    g.add(place(box(2.3, 1.5, 2.1, materials.paintWhite, 0.12), 0, 1.30, 1.0));
    g.add(place(box(2.0, 0.7, 0.08, materials.glass, 0.03), 0, 1.62, 2.02));
    for (const sx of [-1, 1]) {
      for (const sz of [1.4, -1.6, -3.0]) {
        const w = createWheel(0.46, 0.26, sz < 0);
        w.position.set(sx * 0.94, 0.46, sz);
        g.add(w);
      }
    }
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
