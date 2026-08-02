# Heavy Haul

A browser simulator for the kind of driving you described: a 212,000 lb superload
on a multi-axle lowboy, with police units and pilot cars running as a convoy —
blocking side roads ahead of you, holding traffic, and leapfrogging to the next
junction once you are through.

```
npm install
npm run dev      # http://localhost:5173
```

`npm test` runs the physics, convoy and mission suites headlessly (no browser
needed) — after `npm install`, since they import `three` directly.

---

## What this is, and what it isn't

The simulation is the real work here. American Truck Simulator's *look* is a
studio-scale asset problem — years of modelled trucks, scanned highways, licensed
brands — and none of that can be produced from code alone. Every model in this
project is generated procedurally at load time, so the visuals are clean and
readable rather than photoreal.

What is genuinely simulated is the part that makes heavy haul feel different from
driving a truck: the vehicle is a **multibody model**, not a single box with
wheels, and the convoy is a **behavioural system**, not scripted animation.

## The rig

Three rigid bodies, coupled at two pivots, so the combination actually
articulates:

| Unit | Mass | Detail |
|---|---|---|
| Tractor | 9,500 kg | 6×4, long-nose conventional, steer axle + drive tandem |
| Jeep dolly | 5,000 kg | Two axles, spreads deck load forward onto the drives |
| Lowboy | 82,000 kg | Four axles, rear two steerable, 400 MVA transformer on the deck |

That layout is not decorative. Two pivot points are the minimum needed to
reproduce the behaviour that defines this kind of driving — the trailer tracking
well inside the tractor's path through a corner, the load pushing the drives
around under braking, and the slow two-pivot sway that builds if you correct too
fast at speed.

Geometry and spring rates are derived from a static load analysis
(`tools/layout.mjs`) rather than guessed, and it lands on realistic permit
numbers:

```
STEER    11,563 lb        DRIVES   45,787 lb
JEEP     63,000 lb        LOWBOY   91,694 lb
GROSS   212,746 lb
```

### Physics

- **Tires** — Pacejka Magic Formula with load sensitivity and a friction ellipse.
  Load sensitivity is why a heavy rig stops *badly* rather than merely slowly:
  doubling the weight on a tire gives noticeably less than double the grip. It is
  also why duals exist, and the model reflects that — a dual splits its position's
  load across two patches, so each sits lower on the curve and keeps more of its
  friction coefficient.
- **Powertrain** — 600 hp / 2,050 lb-ft diesel torque curve, 18-speed with a deep
  reduction crawler set, 4.56 rear axle, turbo lag, three-stage compression brake,
  and clutch heat so that launching a superload in too tall a gear cooks the
  clutch instead of moving the load.
- **Driveline inertia** — reflected to the wheels through the square of the gear
  ratio. In a crawler gear this is ~1,000 kg·m² per wheel against the wheel's own
  32, and it is what lets the rig feed torque in smoothly on a grade instead of
  instantly lighting up its drives.
- **Air brakes** — reservoir dynamics, application lag (the trailer brakes late,
  which is the trailer-swing mechanism in a panic stop), thermal fade, and spring
  brakes that drop below 35 psi and cannot be released.
- **Suspension** — raycast struts with bump stops, anti-roll bars that transfer
  load across each axle, and chassis contact points so a 22-inch lowboy deck can
  actually ground out on a crest.
- **Aerodynamics** — the load is 12 ft of unfaired steel, and crosswind acts at a
  centre of pressure above the centre of mass, so a gust rolls the rig rather than
  just shoving it.

Validated against real-world figures:

| | |
|---|---|
| 0–30 mph | 28.8 s |
| Braking from 37 mph | 156 ft, 0.30 g |
| Rollover threshold | ~0.47 g lateral (SSF 0.47, CG at 2.10 m) |
| Sustained 7% grade | 11.4 mph steady |

The rollover number is the one that matters. The load's centre of gravity sits
2.1 m up, which puts the tipping point well below what the tires could hold — so
corner speed is limited by the load going over, not by grip. That is why the
advisory speeds are what they are, and why the rollover meter deserves more of
your attention than the speedometer.

## The road

The route is four different roads, and the cross-section is a first-class part
of the world rather than a pair of constants. Sections are declared at arc
lengths and blended across a taper, so a lane opens the way a real one does — the
pavement widens first, and the lane is only usable once the taper has finished.

| | Lanes each way | Centre | Posted |
|---|---|---|---|
| Bennett yard road | 1 | — | 30 |
| County Highway 14 | 1 | double yellow | 45 |
| Ridge Road | 1, no shoulder | double yellow | 35 |
| Cloverdale Pike | 2 | centre turn lane | 35 |
| Substation approach | 1 | — | 25 |

Almost everything the other vehicles on the road do falls out of that. On the
county highway a 3.66 m load in a 3.7 m lane leaves oncoming traffic nowhere to
be except the shoulder, stopped, until the whole formation is past. On the
arterial the same load takes the inside lane and everything coming the other way
simply moves over one and keeps going — the move stops being something that
shuts the road in both directions. The convoy test measures both: **86%** of
oncoming traffic pulls over and stops on the two-lane road, against **2%**
through town.

The paint is geometry, not a baked texture, because the road is not one width for
its whole length: edge lines that follow the pavement wherever it goes, a double
yellow that becomes a turn lane's markings when there is a turn lane, and lane
dividers that exist exactly where there is a second lane to divide.

## The convoy

Four escorts, and the interesting behaviour is the **leapfrog**:

- **Unit 12 / Unit 8** (police) — run ahead, park across the mouth of a side road
  with the lights going, hold it until the whole 87 ft combination is clear, then
  release and run up the closed lane past you to take the next junction nobody is
  covering. Done properly the load never stops, and it looks like every side road
  on the route happens to be closed.
  Through town they hold junctions a different way — see below.
- **Lead** (pilot car) — 140 m out front carrying a height pole set just above the
  load, calling bridges, corners and grades over the radio before you can see them.
- **Chase** (pilot car) — 95 m behind, keeping following traffic off your tail.

Ambient traffic runs an Intelligent Driver Model, and treats the load and every
escort as solid: it follows them, queues behind them and cannot pass through them.
Where there is one lane each way, oncoming vehicles take the shoulder and stop,
because the load is wider than the lane it is travelling in and there is
physically nowhere for them to go — and they stay off until the whole formation
is past, not just the load, because that lane is what the police units leapfrog
up. Where there are two, they move over one instead and carry on.

Traffic coming up behind joins the back of the escort formation and runs at
convoy speed; nothing gets past the rear unit. On the arterial that takes two
units, because there are two lanes for anybody behind to try it in — the chase
car sits in the inside lane behind the load and Unit 8 takes the kerb lane, and a
rolling block with a hole in it is not a rolling block.

## Signals

A signalised intersection changes the escort job completely, and that difference
is the reason the lights are simulated rather than drawn.

At a side road with a stop sign the officer has to physically close it: cross the
carriageway, park across the mouth, and shut the highway down for the few seconds
that takes. At a signal he does not. He **takes the light** — mainline green,
every other approach red — from the kerb on his own side of the road, without
ever crossing in front of anybody. Five of the fourteen junctions on the route
are signalised, and the mission test asserts the load never arrives at one that
is not green for it.

The controllers are real: a fixed cycle per intersection, each starting somewhere
else in its own, with yellow and all-red clearance intervals that no two
conflicting approaches ever overlap. Ambient traffic reads them, stops for a red
and commits through a yellow it cannot stop for. Preemption freezes the
controller at the top of the mainline green and restarts the cycle when the unit
releases it, so the cross street gets a full green afterwards rather than the
tail of one.

A four-way also has traffic on it that is going somewhere. Cars come off the
cross street and drive straight over the highway when the light gives them the
chance, hold on the stop line when a unit has taken it, and will not pull out in
front of the load whatever the signal says — the convoy test asserts nothing is
ever in the intersection box as the load goes through it.

## Cloverdale

The last two miles run through a built-up area, which is a different kind of
driving and is signed and built as one: kerbs and footways, houses set back off
the road with driveways and mailboxes, street lighting on alternate poles, a
signal every quarter mile, and a posted 35 that the advisory speed is now held
under everywhere on the route. The ground beside the road is graded flat for two
lot depths before it blends back into the terrain — a country road can run along
the top of a fill with the ground falling away from the shoulder, but a street
with houses on it cannot.

None of these vehicles are simulated with the rig's physics — they are an arc
length along the route and a lane offset — so their pose is reconstructed for
rendering: they yaw into a lane change before they get there, their front wheels
stay turned for as long as they are turning, and they pitch with the grade.
Without that, a shoulder pull-off is a box being slid sideways across the road.

The mission test asserts all ten junctions are blocked before the load arrives,
and the convoy test asserts nothing on the road ever occupies the same space as
the load.

## The route

7.5 miles from the yard to Cloverdale Substation, surveyed the way a permit route
is — every obstruction known in advance:

- Fourteen junctions for the escorts to hold, five of them signalised crossroads
- Three bridges with posted clearances; the tightest leaves **87 cm** over a
  13'-7" load, and the lead car's pole is your proxy for it
- A 159 m switchback that needs the trailer's rear steer
- A sustained **−9% descent**, where the compression brake is not optional
  equipment — the mission test measures 205 °C in the drums without it against
  139 °C with it
- Two miles of suburban arterial at the end of it, where the road is five lanes
  wide and the escort work is lights rather than roadblocks

## Sound

Synthesised, not sampled — the same constraint as the models. The engine note is
built from its own firing frequency (rpm/20 Hz for a four-stroke six) plus three
harmonics and a half-order rumble, behind a lowpass that opens under load, so it
lugs, revs and shifts because the engine does rather than because a clip was
crossfaded. The compression brake is the same frequency again, used to
amplitude-modulate noise, which is where the bark comes from. Air is filtered
noise fired off transitions — the governor cutting in, the parking brake
dropping, a shift going through. Tire scrub is gated on how saturated the tires
actually are, so it arrives exactly when grip is running out.

Sound starts on the first click, because browsers will not give a page an audio
context before then. <kbd>M</kbd> mutes, and the setting sticks.

## The debrief

The move ends when the load reaches the substation or goes over on its side, and
either way you get a permit officer's sign-off: how close the load came to
rolling, how hot the drums got, whether the air held, whether the rig ever left
the lane the permit routes it down, whether every junction was actually held,
whether a unit had every light, and whether the deck ever touched down.

The scorecard behind it (`src/mission/Scorecard.js`) is the same object the
mission test scores its run with, so the numbers on screen are the numbers the
test suite asserts on rather than a second implementation that can drift.

## Controls

| | | | |
|---|---|---|---|
| Steer | <kbd>A</kbd> <kbd>D</kbd> | Throttle / brake | <kbd>W</kbd> <kbd>S</kbd> |
| Trailer rear steer | <kbd>Q</kbd> <kbd>E</kbd> | Parking brake | <kbd>Space</kbd> |
| Shift up / down | <kbd>Shift</kbd> <kbd>Ctrl</kbd> | Auto shift | <kbd>T</kbd> |
| Compression brake | <kbd>B</kbd> | Diff lock | <kbd>F</kbd> |
| Camera | <kbd>C</kbd> | Look back | <kbd>X</kbd> |
| Lift axle | <kbd>L</kbd> | Reset | <kbd>P</kbd> |
| Pause | <kbd>Esc</kbd> | Mute | <kbd>M</kbd> |

Gamepads work: left stick steers, triggers are the pedals, right stick is the
rear steer. Steering is deliberately rate-limited — a truck's box is about five
turns lock to lock, and a load this tall punishes fast corrections.

Release the parking brake to start. Take the switchback at eight.

## Layout

```
src/
  physics/     RigidBody, Constraints, Tire, Powertrain, Brakes, Vehicle, Rig
  world/       Route (spline, junctions, bridges, grades), Corridor (lanes and
               cross-section), Signal (controllers), Ground (terrain + grip)
  ai/          Traffic (IDM, lanes, signals), Escort (blockades, leapfrog,
               preemption, radio), CrossTraffic, RoadPose
  render/      Scene (sky, lighting, probe), Models, WorldMesh
  audio/       Audio (procedural engine, jake, air, scrub, radio)
  mission/     Scorecard (how the move actually went)
  ui/          HUD, Debrief, style
  core/        Input
test/          physics, convoy, mission, road, scorecard
tools/         layout.mjs (load analysis), plus driving and browser harnesses
```

`tools/` holds the harnesses used to develop and verify the model — the static
load analysis the geometry comes from, acceleration/braking/cornering sweeps, a
convoy simulator, and Playwright scripts that drive the real page. They are the
reason the numbers above are measurements rather than intentions.

In the browser console, `game.jumpTo(metres, mph)` teleports the convoy anywhere
on the route — handy for going straight to the switchback or the grade.
