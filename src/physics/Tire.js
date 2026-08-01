/**
 * Pacejka "Magic Formula" tire model, parameterised for commercial truck radials.
 *
 * Two properties of truck tires matter more than anything else for how a heavy
 * haul rig feels, and both are modelled here:
 *
 *  1. Load sensitivity. The coefficient of friction falls as vertical load
 *     rises, so doubling the weight on a tire gives noticeably less than double
 *     the grip. This is the real reason a 200,000 lb rig needs such enormous
 *     stopping distance -- it is not merely inertia, the tires are also working
 *     further down their friction curve.
 *
 *  2. Low peak mu. A loaded steer tire peaks near 0.7-0.8 on dry asphalt where a
 *     performance car tire is well over 1.0.
 */

/** Magic Formula core: y(x) = D sin(C atan(Bx - E(Bx - atan Bx))). */
function magicFormula(x, B, C, D, E) {
  const Bx = B * x;
  return D * Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
}

export const TRUCK_TIRE = {
  // Lateral
  By: 7.5,
  Cy: 1.30,
  Ey: -1.2,
  // Longitudinal
  Bx: 10.0,
  Cx: 1.65,
  Ex: 0.6,
  // Friction
  mu0: 0.85,        // peak mu at nominal load on dry asphalt
  Fz0: 26000,       // nominal vertical load per tire position, newtons
  loadSensitivity: 0.22, // fractional mu loss per unit of (Fz - Fz0)/Fz0
  rollingResistance: 0.0068,
};

export const STEER_TIRE = { ...TRUCK_TIRE, mu0: 0.88, By: 8.5 };
export const CAR_TIRE = {
  By: 9.5, Cy: 1.35, Ey: -1.0,
  Bx: 12.0, Cx: 1.65, Ex: 0.5,
  mu0: 1.05, Fz0: 4000, loadSensitivity: 0.12,
  rollingResistance: 0.013,
};

/**
 * Effective friction coefficient at a given vertical load.
 * Clamped so that very light or very heavy corners stay physical.
 */
export function frictionAtLoad(params, Fz, surfaceGrip = 1) {
  const rel = (Fz - params.Fz0) / params.Fz0;
  const mu = params.mu0 * (1 - params.loadSensitivity * rel);
  return Math.max(0.15, Math.min(params.mu0 * 1.25, mu)) * surfaceGrip;
}

/**
 * Computes the contact patch force for one tire.
 *
 * @param params        tire parameter set
 * @param slipRatio     kappa, (omega*R - vx) / |vx|
 * @param slipAngle     alpha, radians
 * @param Fz            vertical load, newtons (>= 0)
 * @param surfaceGrip   multiplier for wet/gravel/ice
 * @returns { Fx, Fy, mu, saturation } forces in the tire frame; saturation is
 *          the fraction of available grip in use (>= 1 means sliding).
 */
export function tireForce(params, slipRatio, slipAngle, Fz, surfaceGrip = 1) {
  if (Fz <= 0) return { Fx: 0, Fy: 0, mu: 0, saturation: 0 };

  const mu = frictionAtLoad(params, Fz, surfaceGrip);
  const D = mu * Fz;

  let Fx = magicFormula(slipRatio, params.Bx, params.Cx, D, params.Ex);
  let Fy = magicFormula(slipAngle, params.By, params.Cy, D, params.Ey);

  // Friction ellipse: the tire cannot exceed mu*Fz in the combined direction, so
  // longitudinal demand steals from lateral capability and vice versa. This is
  // what makes braking mid-corner in a loaded rig push the nose wide.
  const combined = Math.hypot(Fx, Fy);
  const saturation = combined / D;
  if (saturation > 1) {
    const scale = 1 / saturation;
    Fx *= scale;
    Fy *= scale;
  }

  return { Fx, Fy, mu, saturation };
}

/**
 * Slip ratio with low-speed conditioning.
 *
 * The textbook definition divides by |vx|, which explodes as the vehicle stops.
 * Clamping the denominator keeps the model finite at a standstill while staying
 * exact at road speed.
 */
export function slipRatio(wheelSpeed, groundSpeed, floor = 2.0) {
  const denom = Math.max(Math.abs(groundSpeed), floor);
  return (wheelSpeed - groundSpeed) / denom;
}

/** Slip angle from contact patch velocity components, radians. */
export function slipAngle(vLong, vLat, floor = 1.5) {
  const denom = Math.max(Math.abs(vLong), floor);
  return Math.atan2(-vLat, denom);
}
