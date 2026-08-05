# Heavy Haul

A browser simulator for heavy-load driving: a superload on a
multi-axle trailer, with police units and pilot cars running as a convoy —
taking the lights ahead of you, blocking side roads, and leapfrogging to the
next junction once you are through. Eight miles across a city, six turns at
signalised intersections, and a run up the interstate in the middle of it.

```
npm install
npm run dev      # http://localhost:5173
```

`npm test` runs the physics, trailer, convoy and mission suites headlessly (no
browser needed) — after `npm install`, since they import `three` directly.

---

## What this is, and what it isn't

The simulation is the real work here. American Truck Simulator's *look* is a
studio-scale asset problem — years of modelled trucks, scanned highways, licensed
brands — and none of that can be produced from code alone. Every model in this
project is generated procedurally at load time, so the visuals are clean and
readable rather than photoreal.

What is genuinely simulated is the part that makes heavy haul feel different from
driving a truck: the combination is a **multibody model**, not a single box with
wheels; the convoy is a **behavioural system**, not scripted animation; and what
is behind the tractor is **declared rather than hard-coded**, so a three-axle
step deck and a two-hundred-and-fifty-foot blade transporter are the same code
with different numbers in it.

## The yard

Five trailers, and picking one is not a skin. It changes the number of rigid
bodies in the combination, the number of axles the weight is spread over, how far
the back of the thing is from the front of it, how far the rear group can be
steered, and how many engines are pushing.

| | Axles | Gross | Length | Height | The problem with it |
|---|---|---|---|---|---|
| **Step deck** | 3 | 145,000 lb | 64 ft | 13.2 ft | None, comparatively. No jeep, no rear steer, no steerman — it goes round a corner the way a truck does. |
| **Lowboy + jeep** | 4 | 212,746 lb | 78 ft | 13.6 ft | The tallest centre of gravity in the yard. This is the one the rollover meter is for. |
| **Beam trailer + jeep** | 6 | 242,729 lb | 180 ft | 13.2 ft | Fifteen metres of girder behind the last axle. The tail does not go where the deck goes. |
| **Dual-lane transporter** | 20, in two lanes | 724,659 lb | 107 ft | 15.6 ft | 328 tonnes, twenty feet wide, four prime movers, and 30 cm under the rail bridge. |
| **Blade transporter** | 5 | 135,584 lb | **249 ft** | 14.9 ft | It weighs less than the excavator and it is four times the length of the lowboy. Getting it round an intersection is the entire job. |

`tools/haul.mjs` drives each of them over the whole route with the same
unremarkable autopilot the mission test uses — hold the advisory speed, aim at
the middle of the permitted lane, gear down on the descent — and reports the
permit officer's sheet:

```
trailer     gross        length  outcome     min   rollover  brakes  off pavement  clearance  junctions

stepdeck     144,844 lb    64 ft  delivered   33      0.32    144C        0.0 m      102 cm      16/16   pass
lowboy       212,746 lb    78 ft  delivered   34      0.40    181C        0.0 m       90 cm      16/16   pass
girder       242,729 lb   180 ft  delivered   36      0.35    170C        0.4 m      103 cm      16/16   pass
duallane     724,659 lb   107 ft  delivered   34      0.24    216C        0.0 m       30 cm      16/16   pass
blade        135,584 lb   249 ft  delivered   33      0.60    112C        2.2 m       50 cm      16/16   warn
```

Read across the rows rather than down them. The heaviest load is the *least*
likely to go over, because a dual-lane platform is three metres out to each side
and the rollover threshold is half the track over the height of the centre of
gravity — its static stability factor is 1.24 against the lowboy's 0.47. What
the big one does instead is cook its brakes and arrive at the rail bridge with a
foot of air over it. And the long one, which weighs less than anything else in
the yard, is the only one that cannot keep itself on the pavement through an
intersection: 2.2 m of it ends up in the verge, which is the "warn" on its sheet.

Everything in `physics/Trailers.js` is declared the way a permit is — the
equipment, then the load — and everything else is derived from it. Where each
unit stands at rest comes from the coupling chain and nothing else; the
suspension mount height comes from the load's own centre of gravity; the length
of the combination comes from whatever sticks out furthest. A trailer therefore
cannot be declared with its wheels buried in the road or its kingpin a metre from
the fifth wheel that is holding it, and `test/trailers.test.js` builds and drives
every one of them to prove it.

Pick one on the start screen, or with `?trailer=blade` in the address bar, or
`game.setTrailer('duallane')` from the console.

## The rig

Up to three rigid bodies, coupled at pivots, so the combination actually
articulates. The default is the lowboy:

| Unit | Mass | Detail |
|---|---|---|
| Tractor | 9,500 kg | 6×4, long-nose conventional, steer axle + drive tandem |
| Jeep dolly | 5,000 kg | Two axles, spreads deck load forward onto the drives |
| Lowboy | 82,000 kg | Four axles, rear two steerable, 400 MVA transformer on the deck |

That layout is not decorative. Two pivot points are the minimum needed to
reproduce the behaviour that defines this kind of driving — the trailer tracking
well inside the tractor's path through a corner, the load pushing the drives
around under braking, and the slow two-pivot sway that builds if you correct too
fast at speed. The trailers with no jeep under them have one pivot instead, and
the code builds whichever chain the spec describes rather than having two copies
of it.

Trailer axles are individually simulated and individually weighed — the permit
readout breaks them out one by one, because on a multi-axle trailer the group
total is not the number anybody argues about. On the lowboy the second axle lifts
(<kbd>L</kbd>), which moves several thousand pounds onto its neighbours.

### The rear steer, and the steerman on the box

Through a corner the back of a trailer cuts inside the tractor's path. That gap
is off-tracking, and it is what decides whether a permit move fits round a bend
at all. Steering the rear axle group *out* of the corner pushes the tail back
out onto the tractor's line.

The geometry says exactly how far: the rear axles trace the same radius as the
gooseneck when they are held at minus the articulation angle. So that is what
the automatics hold — no gain, no tuning, just the angle that makes the two
radii equal, clamped at the box's travel and faded out above manoeuvring speed,
because a rear axle group steering itself at road speed does not shorten
anything, it just wags the tail of a 212,000 lb load.

`tools/offtrack.mjs` measures it on a steady 8 mph corner at ¾ lock — which,
with eight sixty-metre intersection turns on the route, is a corner you take
rather than a hypothetical:

```
rear axles locked straight            9.40 m swept path   (articulation 65.2°)
steerman on the automatics            6.22 m swept path   (articulation 50.5°)
steerman winding it into the corner   8.61 m swept path   (articulation 58.1°)
```

The steerman is on the box by default (<kbd>G</kbd> takes him off it) on every
trailer that has one; the step deck has none, and says so. <kbd>Q</kbd> and
<kbd>E</kbd> override him the instant you touch them, which is the same
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
- **Push trucks** — a dual-lane move has four engines on it, and they are not
  four times one engine. The extras are geared to the same road speed and shift
  together, so one engine model covers all of them, but what each contributes is
  tractive effort through *its own* tires and is capped at what a loaded drive
  tandem can actually hold. Multiplying the tractor's torque instead just spins
  its drives: 328 tonnes needs 205 kN on a six percent grade and one tandem
  cannot put that down. With the push trucks the combination holds 13.8 mph up
  Prospect Hill; without them it stops on it.
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
- **Aerodynamics** — the load is a slab of unfaired steel, and crosswind acts at a
  centre of pressure above the centre of mass, so a gust rolls the rig rather than
  just shoving it.

Validated against real-world figures:

| | |
|---|---|
| 0–30 mph | 28.9 s |
| Braking from 30 mph | 105 ft, 0.30 g |
| Rollover threshold | ~0.47 g lateral (SSF 0.47, CG at 2.10 m) |
| Sustained 6.3% grade | 11.6 mph steady |

The rollover number is the one that matters on the lowboy. The load's centre of
gravity sits 2.1 m up, which puts the tipping point well below what the tires
could hold — so corner speed is limited by the load going over, not by grip. That
is why the advisory speeds are what they are, and why the rollover meter deserves
more of your attention than the speedometer.

## The road

The route is seven different roads, and the cross-section is a first-class part
of the world rather than a pair of constants. Sections are declared at arc
lengths and blended across a taper, so a lane opens the way a real one does — the
pavement widens first, and the lane is only usable once the taper has finished.

| | Lanes each way | Centre | Posted |
|---|---|---|---|
| Terminal Way | 1 | double yellow | 25 |
| Dock Street | 2 | centre turn lane | 30 |
| Harbor Boulevard | 2 | centre turn lane | 35 |
| Market Street (downtown) | 2 | centre turn lane | 25 |
| Prospect Hill Road | 1 | double yellow | 30 |
| I-118 ramps | 1 | — | 25 / 35 |
| Interstate 118 | 3 | concrete barrier | 55 |
| Meridian Avenue | 2 | centre turn lane | 35 |
| Foundry Road | 1 | double yellow | 30 |

The pavement also widens through each of the intersections the load turns at.
That is not decoration: a combination between 64 and 249 feet long swinging
through a sixty-metre radius puts its rear axles well inside the tractor's path,
and the widening is the pavement the trailer needs to track across. It is the
same taper mechanism as the extra lane on the arterial, declared as a short
section with a much wider shoulder either side of the corner.

**The merge is the same mechanism, used the other way round.** The acceleration
lane onto I-118 is a 320 m taper: the pavement reaches full freeway width while
there is still only one lane painted to drive in, and the second and third lanes
open once it has finished. Coming off at exit 14 it runs backwards — three lanes
to one over 300 m, which is why the lead car calls it before the paint starts
running out.

Almost everything the other vehicles on the road do falls out of that. On
Prospect Hill and the industrial roads a 3.66 m load in a 3.7 m lane leaves
oncoming traffic nowhere to be except the kerb, stopped, until the whole
formation is past. On the arterials and the freeway the same load takes the
inside lane and everything coming the other way simply moves over one and keeps
going — the move stops being something that shuts the road in both directions.
The convoy test measures both: **83%** of oncoming traffic pulls over and stops
where there is one lane each way, against **0%** on the multi-lane roads.

The paint is geometry, not a baked texture, because the road is not one width for
its whole length: edge lines that follow the pavement wherever it goes, a double
yellow that becomes a turn lane's markings when there is a turn lane, lane
dividers that exist exactly where there is a second lane to divide, and no yellow
at all on the interstate — where what is down the middle is a barrier and a white
edge line on each side of it.

## The convoy

Four escorts, and the interesting behaviour is the **leapfrog**:

- **Unit 12 / Unit 8** (police) — run ahead, take the light or park across the
  mouth of a side road, hold it until the whole combination is clear, then
  release and run up the closed lane past you to take the next junction nobody is
  covering. Done properly the load never stops, and it looks like every light in
  the city happens to be green.
- **Lead** (pilot car) — 140 m out front carrying a height pole set just above the
  load, calling bridges, corners, ramps and grades over the radio before you can
  see them.
- **Chase** (pilot car) — behind the tail of the load, keeping following traffic
  off it. Where the tail *is* comes from the trailer, so the chase car sits 70 m
  behind a step deck's tailboard and 70 m behind the tip of a 72 m blade rather
  than inside it.

Ambient traffic runs an Intelligent Driver Model, and treats the load and every
escort as solid: it follows them, queues behind them and cannot pass through them.
Where there is one lane each way, oncoming vehicles take the kerb and stop,
because the load is wider than the lane it is travelling in and there is
physically nowhere for them to go — and they stay off until the whole formation
is past, not just the load, because that lane is what the police units leapfrog
up. Where there are two or three, they move over instead and carry on.

Traffic coming up behind joins the back of the escort formation and runs at
convoy speed; nothing gets past the rear unit. On a multi-lane road that takes
two units, because there are two lanes for anybody behind to try it in — the
chase car sits in the inside lane behind the load and Unit 8 takes the kerb lane,
and a rolling block with a hole in it is not a rolling block.

## Signals

A signalised intersection changes the escort job completely, and that difference
is the reason the lights are simulated rather than drawn.

At a side road with a stop sign the officer has to physically close it: cross the
carriageway, park across the mouth, and shut the highway down for the few seconds
that takes. At a signal he does not. He **takes the light** — mainline green,
every other approach red — from the kerb on his own side of the road, without
ever crossing in front of anybody. Ten of the sixteen junctions on the route are
signalised, which is what a city route looks like, and the mission test asserts
the load never arrives at one that is not green for it.

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

**Six of those intersections are junctions the load turns at**, and that is the
difference between escorting a move across a city and down a highway. The unit
does not just hold the cross street: it stops every approach, including the one
behind the load, and the combination swings through the box at seven or eight
miles an hour using both carriageways of the road it is turning into. Sixty
metres on the centreline is what that manoeuvre traces out. A city intersection
is built to a fifteen-metre kerb radius, which nothing in this yard can drive
round — the sixty is the swept path of the manoeuvre that actually happens, and
the pavement is widened through each junction to match.

## The city

Six of the eight miles run between buildings, and that is signed and built as
one: kerbs and footways starting at the pavement edge with no shoulder in
between, towers downtown and three-storey blocks along the arterials, street
lighting on alternate poles, a signal every quarter mile, and posted limits that
drop to 25 through downtown. The ground for a block back from the kerb is graded
flat — a freeway can run along the top of a fill with the ground falling away
from the shoulder, but a street with buildings on it cannot — and it is tinted
as paving rather than grass, because a rendered city with lawn between the
footway and the building line is a business park.

Buildings come from a fixed catalogue of sizes rather than being scaled on the
instance, so that the windows on a tower are the same size as the windows on a
warehouse; one facade texture is drawn per size at that size. Downtown builds
tall in the middle of the district and lower at its edges, which is what makes a
skyline instead of a wall.

None of the vehicles around you are simulated with the rig's physics — they are
an arc length along the route and a lane offset — so their pose is reconstructed
for rendering: they yaw into a lane change before they get there, their front
wheels stay turned for as long as they are turning, and they pitch with the grade.
Without that, a kerbside pull-off is a box being slid sideways across the road.

The mission test asserts all sixteen junctions are blocked before the load
arrives, and the convoy test asserts nothing on the road ever occupies the same
space as the load.

## The route

8.4 miles from Anchor Point Terminal to the Northgate substation, written the way
a survey describes a road rather than as a list of coordinates:

```js
s.run(300, 0.002);
s.mark('onto Dock Street');
s.left(88, 65, 0.002);           // first light: left onto Dock Street
```

That is not a stylistic choice. The centreline used to be forty-eight control
points read off a sketch, and stated that way nobody could see that seven and a
half miles of it contained **three** corners. You cannot see a radius in a list of
coordinates. Stated as turns, the corner is the unit of design, and
`tools/survey.mjs` walks the finished centreline and reports every one of them:

```
corner        at        through   min radius   advisory
  left        353 m     88 deg        60 m       8 mph      onto Dock Street
  right      1725 m     94 deg        69 m       8 mph      onto Harbor Boulevard
  left       3328 m     87 deg        53 m       7 mph      into downtown
  right      4590 m     83 deg        57 m       7 mph      onto Prospect Hill
  right      7098 m     99 deg        51 m       7 mph      the I-118 loop ramp
  right     10230 m     76 deg        63 m       9 mph      off at exit 14
  right     11878 m     88 deg        63 m       8 mph      onto Foundry Road
  right     12988 m     86 deg        51 m       7 mph      in at the Northgate gate
```

(Those directions used to print backwards. `survey.mjs` derived them from the
sign of the heading change and then labelled a positive rotation about +Y as a
right turn, which it is not — see *which way is right* below. The route was
always built from the survey's own `left` and `right`, so only the report was
wrong, but the report is what the route is designed against.)

Twenty-one corners in all, eight of them turns off one road onto another. The
survey is also where everything else on the route is placed from: every junction,
bridge, grade, ramp and change of cross-section is declared at a named mark rather
than at a number, so moving a corner moves everything standing on it instead of
leaving a bridge in a field.

- Sixteen junctions for the escorts to hold, ten of them signalised crossroads,
  and six of those are junctions the load **turns at**
- Four structures with posted clearances; the tightest leaves **90 cm** over the
  lowboy and **30 cm** over the dual-lane transformer, and the lead car's pole is
  your proxy for it
- A sustained **−9% descent** off Prospect Hill with a signalised junction at the
  bottom of it, where the compression brake is not optional equipment — the
  mission test measures 244 °C in the drums without it against 181 °C with it
- A mile and a half of interstate, entered at a fifty-metre-radius loop ramp and
  left at an exit, where the escort work is a rolling block in three lanes rather
  than roadblocks

The move takes about **34 minutes**, most of which is the eight turns: a
212,000 lb load does not carry speed into a sixty-metre radius, and the lead car
calls each one over the radio before you can see it.

## What a frame costs

The simulation is only half of whether this runs well; the other half is what
gets handed to the GPU, and for a long time that was around twelve hundred draw
calls and 736,000 triangles — most of it not visible.

Three things were wrong, and they compounded:

**Nothing culled.** Three.js culls by bounding sphere, and the terrain, the
trees, the guardrail, the power poles, the whole city and every painted line were
each a single object spanning the entire route. Their bounding spheres were miles
across, so they were never off screen and all of it was submitted every frame —
and again for the shadow map. Everything static is built in 320 m chunks now,
which is what lets the frustum test answer "no".

**Everything was inside the far plane.** Six kilometres of draw distance on a
thirteen-kilometre route meant downtown was being drawn from seven kilometres
away, through fog that had already faded it to flat grey. Detail carries its own
cull range now — buildings and trees at 1.7 km, street furniture and lane paint
under a kilometre — which is what makes it affordable to see the city the route
runs through at all.

**A body panel was three hundred triangles.** Every part of every vehicle was a
`RoundedBoxGeometry` at two segments of corner detail, twenty-five times a plain
box, for a fillet a few centimetres across. One segment reads the same; under
about three centimetres of radius the rounding is dropped entirely. The parts of
a vehicle that share a material are also welded into one buffer, so a car is ten
meshes rather than fifteen and the rig is twenty rather than sixty-five. Wheels
stay separate because they turn — except a car's rear pair, which turns about one
axle line and so is exact to weld.

```
                     before          after           city
draw calls        826 – 1,179      271 – 775      506 – 868
triangles      697k – 738k       71k – 229k     150k – 247k
draw distance         6 km            9 km           9 km
```

The city costs more than the country road it replaced, which is what a city is:
there is simply more of it in front of you at any moment, and none of it is behind
a hill. `tools/frame.mjs` produces that table from the running page and
`tools/perf.mjs` measures the simulation headlessly — it is about 0.6 ms a
frame, three percent of a 60 Hz budget, with the physics running at 200 Hz
underneath it and up to fifty wheels on the road under the dual-lane platform.

Two things sit on top. Resolution scales down toward half when the frame runs
late and back up after two seconds comfortably inside budget, because a dropped
frame is far more visible than a soft edge. And a road's worth of traffic is
built at load time and parked in the pool, so a car appearing at the intersection
ahead is a transform update rather than a dozen geometries, a merge and a shader
compile inside one frame.

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

Release the parking brake to start. Take the loop ramp at seven.

## Layout

```
src/
  physics/     RigidBody, Constraints, Tire, Powertrain, Brakes, Vehicle, Rig,
               Trailers (the yard: what goes behind the tractor)
  world/       Survey (the centreline, as runs and turns), Route (junctions,
               bridges, ramps, grades, projection), Corridor (lanes and
               cross-section), Signal (controllers), Ground (terrain + grip)
  ai/          Traffic (IDM, lanes, signals), Escort (blockades, leapfrog,
               preemption, radio), CrossTraffic, RoadPose
  render/      Scene (sky, lighting, probe), Models, WorldMesh
  audio/       Audio (procedural engine, jake, air, scrub, radio)
  mission/     Scorecard (how the move actually went)
  ui/          HUD, Debrief, style
  core/        Input
test/          physics, trailers, convoy, mission, road, scorecard, handedness
tools/         layout.mjs (load analysis), survey.mjs (every corner on the
               route), haul.mjs (every trailer over the whole route),
               perf.mjs and frame.mjs (what a frame costs), plus the driving
               and browser harnesses
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
on the route — handy for going straight to the loop ramp or the descent — and
`game.setTrailer(id)` swaps what is behind the tractor.
