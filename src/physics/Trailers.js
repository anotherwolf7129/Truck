import { Vector3 } from 'three';

/**
 * Selectable trailer and load combinations.
 *
 * Each entry describes a real class of heavy haul move. They differ in the ways
 * that actually change the driving:
 *
 *  - axle count, which sets how the deck load is spread and therefore how much
 *    weight each tire carries;
 *  - length, which sets how far the trailer off-tracks through a corner and how
 *    much road the rig needs at a junction;
 *  - the load's height and centre of gravity, which sets the rollover threshold
 *    and the bridge clearance.
 *
 * `gooseneckZ` is where the trailer couples to the jeep, measured forward from
 * the trailer's centre of mass. Together with the axle group's centroid it
 * decides how the deck load splits between the tractor and the trailer's own
 * axles -- see tools/layout.mjs.
 */
export const TRAILER_CONFIGS = [
  {
    id: 'lowboy4',
    name: '4-axle lowboy',
    blurb: 'The standard superload rig. 212,000 lb, 87 ft, tall and tippy.',
    tare: 14000,
    axleZ: [-4.10, -5.45, -6.80, -8.15],
    steerFromIndex: 2,
    liftableIndex: 1,
    gooseneckZ: 6.30,
    deckHalfWidth: 1.52,
    trackHalfWidth: 0.98,
    wheelRadius: 0.46,
    cargo: {
      name: 'Substation transformer, 400 MVA',
      mass: 68000,
      size: new Vector3(3.66, 3.60, 8.40),
      centerHeight: 2.35,
    },
  },
  {
    id: 'lowboy6',
    name: '6-axle stretch lowboy',
    blurb: 'Heavier again at 268,000 lb. More axles to spread it, more length to swing.',
    tare: 19000,
    axleZ: [-5.20, -6.55, -7.90, -9.25, -10.60, -11.95],
    steerFromIndex: 3,
    liftableIndex: 1,
    gooseneckZ: 9.00,
    deckHalfWidth: 1.75,
    trackHalfWidth: 1.02,
    wheelRadius: 0.46,
    cargo: {
      name: 'Hydraulic press bed, 4000 ton',
      mass: 88000,
      size: new Vector3(4.20, 3.30, 12.00),
      centerHeight: 2.20,
    },
  },
  {
    id: 'girder8',
    name: '8-axle girder trailer',
    blurb: '150 ft of combination under a single steel girder. Light on each tire, enormous to place.',
    tare: 26000,
    axleZ: [-7.00, -8.35, -9.70, -11.05, -12.40, -13.75, -15.10, -16.45],
    steerFromIndex: 4,
    liftableIndex: null,
    gooseneckZ: 12.50,
    deckHalfWidth: 1.30,
    trackHalfWidth: 1.02,
    wheelRadius: 0.46,
    cargo: {
      name: 'Welded plate girder, 112 ft span',
      mass: 78000,
      size: new Vector3(2.60, 3.20, 34.00),
      centerHeight: 2.15,
    },
  },
];

export function trailerConfig(id) {
  return TRAILER_CONFIGS.find((c) => c.id === id) ?? TRAILER_CONFIGS[0];
}

/**
 * Static load split for a configuration, used both to size the springs and to
 * sanity check that no axle group is grossly over or under loaded.
 */
export function loadSplit(config) {
  const mass = config.tare + config.cargo.mass;
  const axleCentroid =
    config.axleZ.reduce((a, z) => a + z, 0) / config.axleZ.length;
  const arm = -axleCentroid;                       // distance behind the centre of mass
  const gooseneckFraction = arm / (config.gooseneckZ + arm);
  const axleFraction = 1 - gooseneckFraction;

  const wheels = config.axleZ.length * 2;
  const axleLoadN = mass * 9.81 * axleFraction;
  return {
    mass,
    axleCentroid,
    gooseneckFraction,
    axleFraction,
    wheels,
    axleLoadN,
    perWheelN: axleLoadN / wheels,
    gooseneckN: mass * 9.81 * gooseneckFraction,
  };
}
