import { Vector3 } from 'three';

/**
 * The trailers this outfit runs, and the loads that go on them.
 *
 * A heavy haul yard is not one trailer. What is under the load decides almost
 * everything about the move: how many axles the weight is spread over, how far
 * the back of the combination is from the front of it, whether the tail can be
 * steered round a corner at all, and whether one tractor can move it or three.
 * So the trailer is a declared thing rather than something hard-coded into the
 * rig, and `Rig` builds whatever it is handed.
 *
 * Each spec is written the way a permit is: the equipment, then the load, then
 * the numbers the permit office cares about. Everything else -- suspension
 * geometry, the resting position of each unit, the length of the combination --
 * is derived from those, so a trailer cannot be declared with its wheels buried
 * in the road or its gooseneck a metre from its kingpin.
 *
 * Lengths are metres in each unit's own local frame: +Z is forward, and the
 * origin is that unit's centre of mass. A trailer's `couplingZ` is therefore how
 * far ahead of its own centre the gooseneck pin sits, and its axles are negative.
 */

/** Evenly spaced axle stations, front to back. */
function axleRow(count, from, spacing) {
  return Array.from({ length: count }, (_, i) => from - i * spacing);
}

/** The two-axle jeep dolly used under most of the deck trailers. */
const JEEP = {
  mass: 5000,
  size: new Vector3(2.5, 1.4, 5.2),
  kingpinZ: 2.20,          // where the tractor's fifth wheel picks it up
  fifthWheelZ: -0.30,      // where it picks up the trailer's gooseneck
  axleZ: [-1.00, -2.35],
  track: 0.94,
  antiRoll: 320000,
};

/** A four-axle jeep, for spreading a dual-lane platform's nose load. */
const HEAVY_JEEP = {
  ...JEEP,
  mass: 9200,
  size: new Vector3(2.6, 1.5, 8.4),
  axleZ: [-1.00, -2.35, -3.70, -5.05],
};

/** Suspension and brakes for a normal multi-axle trailer position. */
const TRAILER_AXLE = {
  radius: 0.46,
  restLength: 0.26,
  stiffness: 700000,
  damping: 40000,
  maxTravel: 0.16,
  brakeTorque: 8600,
  brakeThermalMass: 26000,
  brakeLag: 0.32,
};

export const TRAILERS = [
  // ---------------------------------------------------------------------------
  {
    id: 'stepdeck',
    axleLabel: 'Deck',
    name: 'Three-axle step deck',
    permitNo: '24-0774-OS',
    summary: '48 t excavator, 145,000 lb gross',
    blurb:
      'The smallest thing in the yard that still needs a permit. Three axles, no '
      + 'jeep, no rear steer and no steerman — a 64 ft combination that goes round '
      + 'a corner the way a truck does. Start here if you have never moved one.',
    tare: 8200,
    deckHeight: 0.98,
    deckWidth: 2.80,
    bodyWidth: 3.55,
    bodyLength: 13.0,
    deckFrom: 3.4,
    deckTo: -7.6,
    tailZ: -8.0,
    couplingZ: 5.60,
    axles: axleRow(3, -4.20, 1.35).map((z, i) => ({ z, lift: i === 1 })),
    track: 0.95,
    axle: { ...TRAILER_AXLE, radius: 0.50, stiffness: 620000, damping: 36000, brakeTorque: 8200 },
    maxRearSteer: 0,
    antiRoll: 380000,
    jeep: null,
    powerUnits: 1,
    cargo: {
      name: '48-tonne tracked excavator',
      kind: 'excavator',
      mass: 48000,
      size: new Vector3(3.55, 3.05, 8.60),
      centerHeight: 0.98 + 1.45,
      z: -1.0,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: 'lowboy',
    axleLabel: 'Lowboy',
    name: 'Four-axle lowboy and jeep',
    permitNo: '24-0881-OS',
    summary: '400 MVA transformer, 212,000 lb gross',
    blurb:
      'The classic permit move: a dropped well deck behind a two-axle jeep, four '
      + 'axles under the load and the rear two on the steerman\'s box. Twelve feet '
      + 'wide, thirteen and a half high, and the tallest centre of gravity in the '
      + 'yard — this is the one the rollover meter is for.',
    tare: 14000,
    deckHeight: 0.55,
    deckWidth: 3.05,
    bodyWidth: 3.6,
    bodyLength: 16.0,
    deckFrom: 5.1,
    deckTo: -4.3,
    tailZ: -9.0,
    couplingZ: 6.30,
    axles: axleRow(4, -4.10, 1.35).map((z, i) => ({ z, steer: i >= 2, lift: i === 1 })),
    track: 0.98,
    axle: TRAILER_AXLE,
    maxRearSteer: 0.44,
    antiRoll: 420000,
    jeep: JEEP,
    powerUnits: 1,
    cargo: {
      name: 'Substation transformer, 400 MVA',
      kind: 'transformer',
      mass: 68000,
      size: new Vector3(3.66, 3.60, 8.40),
      centerHeight: 2.35,
      z: 0.4,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: 'girder',
    axleLabel: 'Beam',
    name: 'Six-axle stretch beam trailer',
    permitNo: '24-0903-OS',
    summary: 'Twin 46 m plate girders, 243,000 lb gross',
    blurb:
      'A beam trailer pulled out to its stops with two bridge girders on it, '
      + 'fifteen metres of which are behind the back axle. The tail does not go '
      + 'where the deck goes and it does not stop when you do — this is the one '
      + 'that teaches you what rear overhang means.',
    tare: 21000,
    deckHeight: 1.02,
    deckWidth: 3.00,
    bodyWidth: 3.60,
    bodyLength: 34.0,
    deckFrom: 13.0,
    deckTo: -18.6,
    tailZ: -19.4,
    couplingZ: 14.40,
    axles: axleRow(6, -10.00, 1.55).map((z, i) => ({ z, steer: i >= 3 })),
    track: 0.98,
    axle: TRAILER_AXLE,
    maxRearSteer: 0.60,
    antiRoll: 400000,
    jeep: { ...JEEP, mass: 5600 },
    powerUnits: 1,
    cargo: {
      name: 'Twin plate girders, Foundry Road overpass',
      kind: 'girder',
      mass: 74000,
      size: new Vector3(3.60, 3.00, 46.0),
      centerHeight: 1.02 + 1.50,
      z: -9.0,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: 'duallane',
    axleLabel: 'Line',
    name: 'Twenty-axle dual-lane transporter',
    permitNo: '24-0940-SL',
    summary: '232 t transformer, 719,000 lb gross',
    blurb:
      'The big one. Twenty axles in two lanes under a 232 tonne generator step-up '
      + 'transformer, twenty feet wide, with four prime movers on the combination '
      + 'because one cannot start it. It will not roll over — the track is wider '
      + 'than the load is tall — but it will not stop either, and it does not fit '
      + 'anywhere.',
    tare: 78000,
    deckHeight: 0.80,
    deckWidth: 6.20,
    bodyWidth: 6.30,
    bodyLength: 26.0,
    deckFrom: 8.0,
    deckTo: -10.6,
    tailZ: -11.2,
    couplingZ: 13.00,
    // Ten axle lines, each of them two lanes wide. The whole point of the layout
    // is that the platform sits under the load and carries nearly all of it: the
    // drawbar reaches thirteen metres forward to the jeep, so barely a tenth of
    // 326 tonnes ever reaches the tractor.
    axles: axleRow(10, 5.90, 1.70).map((z, i) => ({ z, steer: i >= 6 })),
    track: [1.15, 2.95],
    axle: { ...TRAILER_AXLE, stiffness: 820000, damping: 46000 },
    maxRearSteer: 0.55,
    antiRoll: 900000,
    jeep: HEAVY_JEEP,
    // A pull tractor, a second on the drawbar and two push trucks on the back.
    // 232 tonnes does not move on 600 hp, which is why these moves are never
    // photographed with one truck in the picture.
    powerUnits: 4,
    solverIterations: 16,
    cargo: {
      name: '750 MVA generator step-up transformer',
      kind: 'transformer',
      mass: 232000,
      size: new Vector3(6.10, 3.95, 12.60),
      centerHeight: 0.80 + 1.98,
      z: -1.0,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: 'blade',
    axleLabel: 'Cradle',
    name: '72 m blade transporter',
    permitNo: '24-0917-OS',
    summary: '72 m turbine blade, 249 ft combination',
    blurb:
      'The long one. A single 72 metre blade on a stretched cradle trailer, '
      + 'twenty-two metres of it hanging off the back of the last axle. It weighs '
      + 'less than the excavator and it is four times the length of the lowboy: '
      + 'nothing about it is difficult except getting it round a corner, and that '
      + 'is very difficult indeed. The rear group steers fifty degrees and you '
      + 'will use all of it.',
    tare: 24000,
    deckHeight: 1.25,
    deckWidth: 2.90,
    bodyWidth: 3.90,
    bodyLength: 78.0,
    deckFrom: 28.0,
    deckTo: -18.0,
    tailZ: -40.0,
    couplingZ: 30.00,
    axles: axleRow(5, -10.40, 1.80).map((z, i) => ({ z, steer: i >= 1 })),
    track: 0.98,
    axle: { ...TRAILER_AXLE, stiffness: 520000, damping: 32000 },
    maxRearSteer: 0.90,
    antiRoll: 260000,
    jeep: null,
    powerUnits: 1,
    // A body eighty metres long has five hundred times the tractor's yaw inertia.
    // The pivot between them needs more passes to stay tight.
    solverIterations: 20,
    cargo: {
      name: '72 m turbine blade, Northgate wind farm',
      kind: 'blade',
      mass: 28000,
      size: new Vector3(3.90, 3.30, 72.0),
      centerHeight: 1.25 + 1.65,
      z: -4.0,
    },
  },
];

export const DEFAULT_TRAILER = 'lowboy';

const BY_ID = new Map(TRAILERS.map((t) => [t.id, t]));

/** A trailer spec by id, falling back to the default rather than throwing. */
export function getTrailer(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_TRAILER);
}

/**
 * Fills in everything a spec implies but does not state.
 *
 * The derived numbers are the ones it would be easy to get quietly wrong by
 * hand: where each unit rests relative to the tractor (which follows from the
 * coupling positions and nothing else), how tall the load stands, how long the
 * whole combination is, and how far the outermost tire is from the centreline —
 * which is what the rollover threshold is measured against.
 */
export function resolveTrailer(spec, cargoOverride = null) {
  const cargo = cargoOverride ? { ...spec.cargo, ...cargoOverride } : spec.cargo;
  const tracks = Array.isArray(spec.track) ? spec.track : [spec.track];
  const jeep = spec.jeep;

  // Coupling chain, front to back. The tractor's fifth wheel is the fixed point
  // everything else hangs off; each unit's resting offset is wherever its own
  // kingpin has to be for the pin above it to line up.
  const tractorFifthZ = -2.10;
  const jeepOffset = jeep ? tractorFifthZ - jeep.kingpinZ : null;
  const trailerOffset = jeep
    ? jeepOffset + jeep.fifthWheelZ - spec.couplingZ
    : tractorFifthZ - spec.couplingZ;

  // Nose of the hood to the back of whatever sticks out furthest, which is the
  // number the escorts station-keep off and the traffic queues behind.
  const tail = Math.min(spec.tailZ, cargo.z - cargo.size.z * 0.5);
  const combinationLength = 3.8 - (trailerOffset + tail);

  return {
    ...spec,
    cargo,
    jeepOffset,
    trailerOffset,
    combinationLength,
    loadHeight: spec.deckHeight + cargo.size.y,
    halfTrack: Math.max(...tracks),
    tracks,
    solverIterations: spec.solverIterations ?? 12,
    powerUnits: spec.powerUnits ?? 1,
  };
}
