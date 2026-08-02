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

The lowboy's four axles are individually simulated and individually weighed —
the permit readout breaks them out one by one, because on a multi-axle trailer
the group total is not the number anybody argues about. The second axle lifts
(<kbd>L</kbd>), which moves several thousand pounds onto its neighbours; the
rear two steer.

### The rear steer, and the steerman on the box

Through a corner the back of a lowboy cuts inside the tractor's path. That gap
is off-tracking, and it is what decides whether a permit move fits round a bend
at all. Steering the rear axle group *out* of the corner pushes the tail back
out onto the tractor's line.

The geometry says exactly how far: the rear axles trace the same radius as the
gooseneck when they are held at minus the articulation angle. So that is what
the automatics hold — no gain, no tuning, just the angle that makes the two
radii equal, clamped at the box's 25° of travel and faded out above manoeuvring
speed, because a rear axle group steering itself at road speed does not shorten
anything, it just wags the tail of a 212,000 lb load.

`tools/offtrack.mjs` measures it on a steady 8 mph corner at ¾ lock — which,
now that there are seven turns on the route at around a hundred metres, is a
corner you take rather than a hypothetical:

```
rear axles locked straight            9.40 m swept path   (articulation 65.2°)
steerman on the automatics            6.23 m swept path   (articulation 50.6°)
steerman winding it into the corner   8.61 m swept path   (articulation 58.1°)
```

The steerman is on the box by default (<kbd>G</kbd> takes him off it). <kbd>Q</kbd>
and <kbd>E</kbd> override him the instant you touch them, which is the same
arrangement as a real crew: the automatics hold the line, the driver takes it off
them when he wants the tail somewhere the geometry would not put it.

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
| Valley Road | 1 | double yellow | 45 |
| Cloverdale Pike | 2 | centre turn lane | 35 |
| Substation approach | 1 | — | 25 |

The pavement also widens through each of the turns onto a new road. That is not
decoration: a 87 ft combination swinging through a hundred-metre radius puts its
rear axles well inside the tractor's path, and the widening is the pavement the
trailer needs to track across. It is the same taper mechanism as the extra lane
in town, declared as a short section with a wider shoulder.

Almost everything the other vehicles on the road do falls out of that. On the
county highway a 3.66 m load in a 3.7 m lane leaves oncoming traffic nowhere to
be except the shoulder, stopped, until the whole formation is past. On the
arterial the same load takes the inside lane and everything coming the other way
simply moves over one and keeps going — the move stops being something that
shuts the road in both directions. The convoy test measures both: **82%** of
oncoming traffic pulls over and stops on the two-lane road, against **1%**
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

The mission test asserts all fourteen junctions are blocked before the load arrives,
and the convoy test asserts nothing on the road ever occupies the same space as
the load.

## The route

8.1 miles from the yard to Cloverdale Substation, written the way a survey
describes a road rather than as a list of coordinates:

```js
s.run(210);
s.mark('onto CH14');
s.left(86, 115);                 // onto County Highway 14
```

That is not a stylistic choice. The centreline used to be forty-eight control
points read off a sketch, and stated that way nobody could see that the whole
seven and a half miles contained **three** corners — everything between the
switchback and the valley bend was a curve of over a kilometre's radius, which
from the cab is a straight line. You cannot see a radius in a list of
coordinates. Stated as turns, the corner is the unit of design, and
`tools/survey.mjs` walks the finished centreline and reports every one of them:

```
corner        at        through   min radius   advisory
  right       298 m     86 deg       111 m       9 mph      onto County Highway 14
  right      2318 m     76 deg       109 m       9 mph      at the County Route 9 signal
  left       3723 m     64 deg       119 m      10 mph      onto Ridge Road
  right      4985 m    158 deg        95 m       7 mph      the switchback
  left       7050 m     84 deg       110 m       9 mph      onto Valley Road
  right      9063 m     78 deg       109 m      10 mph      into Cloverdale
  left      12498 m     88 deg       102 m       8 mph      in at the substation gate
```

Twenty-nine corners in all, seven of them turns off one road onto another. The
survey is also where everything else on the route is placed from: every junction,
bridge, grade and change of cross-section is declared at a named mark rather than
at a number, so moving a corner moves everything standing on it instead of
leaving a bridge in a field.

- Fourteen junctions for the escorts to hold, five of them signalised crossroads,
  and one of those is a junction the load **turns at** — the unit takes the light
  and the load swings through the intersection at nine miles an hour
- Three bridges with posted clearances; the tightest leaves **87 cm** over a
  13'-7" load, and the lead car's pole is your proxy for it
- A 103 m switchback through 158°, which is what the trailer's rear steer exists
  for
- A sustained **−9% descent**, where the compression brake is not optional
  equipment — the mission test measures 274 °C in the drums without it against
  187 °C with it
- A mile and a half of suburban arterial at the end of it, where the road is five
  lanes wide and the escort work is lights rather than roadblocks

The move takes about **28 minutes**, most of which is the seven turns: a
212,000 lb load does not carry speed into a hundred-metre radius, and the lead
car calls each one over the radio before you can see it.

## What a frame costs

The simulation is only half of whether this runs well; the other half is what
gets handed to the GPU, and for a long time that was around twelve hundred draw
calls and 736,000 triangles — most of it not visible.

Three things were wrong, and they compounded:

**Nothing culled.** Three.js culls by bounding sphere, and the terrain, the
2,600 trees, the guardrail, the power poles, the whole town and every painted
line were each a single object spanning the entire route. Their bounding spheres
were seven miles across, so they were never off screen and all of it was
submitted every frame — and again for the shadow map. Everything static is built
in 320 m chunks now, which is what lets the frustum test answer "no".

**Everything was inside the far plane.** Six kilometres of draw distance on a
twelve-kilometre route meant the town was being drawn from seven kilometres away,
through fog that had already faded it to flat grey. Detail carries its own cull
range now — trees at 1.7 km, street furniture and lane paint under a kilometre —
which is what makes it affordable to see the country the route runs through at
all.

**A body panel was three hundred triangles.** Every part of every vehicle was a
`RoundedBoxGeometry` at two segments of corner detail, twenty-five times a plain
box, for a fillet a few centimetres across. One segment reads the same; under
about three centimetres of radius the rounding is dropped entirely. The parts of
a vehicle that share a material are also welded into one buffer, so a car is ten
meshes rather than fifteen and the rig is twenty rather than sixty-five. Wheels
stay separate because they turn — except a car's rear pair, which turns about one
axle line and so is exact to weld.

```
                     before          after
draw calls        826 – 1,179      271 – 775
triangles      697k – 738k       71k – 229k
draw distance         6 km            9 km
```

`tools/frame.mjs` produces that table from the running page and
`tools/perf.mjs` measures the simulation headlessly — it is about 0.6 ms a
frame, four percent of a 60 Hz budget, with the physics running at 200 Hz
underneath it.

Two things sit on top. Resolution scales down toward half when the frame runs
late and back up after two seconds comfortably inside budget, because a dropped
frame is far more visible than a soft edge. And a road's worth of traffic is
built at load time and parked in the pool, so a car appearing over the crest is a
transform update rather than a dozen geometries, a merge and a shader compile
inside one frame.

### Why the traffic used to judder

Worth its own note, because it looked like a rendering problem and was not.
Everything whose position comes from an arc length — all the ambient traffic, all
four escorts, every car on a cross street — was placed by snapping to the nearest
of 2,401 samples along the route. Those samples are five metres apart. So a car
doing 45 mph stood still for a quarter of a second and then teleported five
metres forward, and no amount of smoothing downstream could fix it, because the
motion was never there. The route interpolates between samples now.

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
| Trailer rear steer | <kbd>Q</kbd> <kbd>E</kbd> | Steerman (auto rear steer) | <kbd>G</kbd> |
| Parking brake | <kbd>Space</kbd> | Shift up / down | <kbd>Shift</kbd> <kbd>Ctrl</kbd> |
| Auto shift | <kbd>T</kbd> | Compression brake | <kbd>B</kbd> |
| Diff lock | <kbd>F</kbd> | Camera | <kbd>C</kbd> |
| Look back | <kbd>X</kbd> | Lift axle | <kbd>L</kbd> |
| Reset | <kbd>P</kbd> | Pause | <kbd>Esc</kbd> |
| Mute | <kbd>M</kbd> | | |

Arrow keys mirror <kbd>WASD</kbd>. Gamepads work: left stick steers, triggers are
the pedals, right stick is the rear steer. Steering is deliberately rate-limited
— a truck's box is about five turns lock to lock, and a load this tall punishes
fast corrections.

Release the parking brake to start. Take the switchback at eight.

## Layout

```
src/
  physics/     RigidBody, Constraints, Tire, Powertrain, Brakes, Vehicle, Rig
  world/       Survey (the centreline, as runs and turns), Route (junctions,
               bridges, grades, projection), Corridor (lanes and cross-section),
               Signal (controllers), Ground (terrain + grip)
  ai/          Traffic (IDM, lanes, signals), Escort (blockades, leapfrog,
               preemption, radio), CrossTraffic, RoadPose
  render/      Scene (sky, lighting, probe), Models, WorldMesh
  audio/       Audio (procedural engine, jake, air, scrub, radio)
  mission/     Scorecard (how the move actually went)
  ui/          HUD, Debrief, style
  core/        Input
test/          physics, convoy, mission, road, scorecard, handedness
tools/         layout.mjs (load analysis), survey.mjs (every corner on the
               route), perf.mjs and frame.mjs (what a frame costs), plus the
               driving and browser harnesses
```

### Which way is right

Three.js is right-handed. With +Y up and the rig facing +Z, the driver's
right-hand side is `forward × up`, which is **−X**, and a right turn is a
**negative** rotation about +Y. The axis labels suggest otherwise and that has
cost this project twice: getting it backwards mirrors the entire simulation, so
the right arrow key steers left and the load drives up the oncoming lane.

Two constants carry the convention — `LOCAL_RIGHT` in `physics/Vehicle.js` and
the lateral axis in `world/Route.js` — and every steer angle below
`Rig.applySteering` is stored as the raw rotation about +Y, so the sign flip
lives in exactly one place instead of being scattered. `test/handedness.test.js`
asserts the observable end of it: which way the rig goes when you press the
right arrow, and which side of the paint the permitted lane is on.

`tools/` holds the harnesses used to develop and verify the model — the static
load analysis the geometry comes from, acceleration/braking/cornering sweeps, a
convoy simulator, and Playwright scripts that drive the real page. They are the
reason the numbers above are measurements rather than intentions.

In the browser console, `game.jumpTo(metres, mph)` teleports the convoy anywhere
on the route — handy for going straight to the switchback or the grade.
