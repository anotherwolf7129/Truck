# Heavy Haul

A browser simulator for the kind of driving you described: a 212,000 lb superload
on a multi-axle lowboy, with police units and pilot cars running as a convoy —
blocking side roads ahead of you, holding traffic, and leapfrogging to the next
junction once you are through.

### Just want to play it

Download **[`heavy-haul.html`](heavy-haul.html)** and open it in your browser.
That one file is the whole game — Three.js, the simulation and the stylesheet are
all inlined, so it needs no server, no install and no network connection.

(On GitHub, use the download button on the file page. Viewing it in the web UI
shows you the source rather than running it.)

### Working on it

```
npm install
npm run dev            # http://localhost:5173
npm run build:single   # regenerate heavy-haul.html
```

`npm test` runs the physics and mission suites headlessly (no browser needed).

It wants a real GPU. Any machine with hardware WebGL is fine; software rendering
will crawl.

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

| Unit | Detail |
|---|---|
| Tractor | 9,500 kg. 6×4, long-nose conventional, steer axle + drive tandem |
| Jeep dolly | 5,000 kg. Two axles, spreads deck load forward onto the drives |
| Lowboy | The bit you choose — see below |

Three trailers are selectable on the start screen, and they change the driving,
not just the silhouette:

| Trailer | Load | Gross | Length |
|---|---|---|---|
| 4-axle lowboy | 400 MVA transformer | 212,746 lb | 90 ft |
| 6-axle stretch lowboy | 4000-ton press bed | 267,861 lb | 111 ft |
| 8-axle girder trailer | 112 ft welded plate girder | 261,247 lb | 137 ft |

More axles spread the deck load — 11,462 lb per wheel position on the four-axle
against 7,397 on the eight — while more length means more off-tracking through
every corner and more road needed at every junction. Axle positions, spring
rates, deck geometry and the hitch anchor are all derived from the configuration
rather than hand-placed, so each one is sized correctly for its own load.

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
- **Aerodynamics** — the load is a slab of unfaired steel, and crosswind acts at
  a centre of pressure above the centre of mass, so a gust rolls the rig rather
  than just shoving it.
- **Command steer** — the trailer's rear axles are slaved to the articulation at
  the gooseneck, the way a real lowboy of this length is. It runs itself; the
  measured effect through the switchback is off-tracking cut from 0.57 m to
  0.16 m (`tools/offtrack.mjs`).

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

## The convoy

Four escorts, and the interesting behaviour is the **leapfrog**:

- **Unit 12 / Unit 8** (police) — run ahead, park across the mouth of a side road
  with the lights going, hold it until the whole combination is clear, then
  release and run up the shoulder past you to take the next junction nobody is
  covering. Done properly the load never stops, and it looks like every side road
  on the route happens to be closed.
- **Lead** (pilot car) — about 200 ft out front carrying a height pole set just
  above the load, calling bridges, corners and grades over the radio before you
  can see them.
- **Chase** (pilot car) — just off your tail, keeping following traffic back.

Ambient traffic runs an Intelligent Driver Model. Oncoming vehicles take the
shoulder and stop, because the load is wider than the lane it is travelling in and
there is physically nowhere for them to go. Traffic behind queues at convoy speed
rather than passing.

The mission test asserts all ten junctions are blocked before the load arrives.

## The route

7.5 miles from the yard to Cloverdale Substation, surveyed the way a permit route
is — every obstruction known in advance:

- Ten junctions for the escorts to hold
- Three bridges with posted clearances; the tightest leaves **87 cm** over a
  13'-7" load, and the lead car's pole is your proxy for it
- A 159 m switchback that needs the trailer's rear steer
- A sustained **−9% descent**, where the compression brake is not optional
  equipment — the mission test measures 211 °C in the drums without it against
  145 °C with it

## Controls

| | | | |
|---|---|---|---|
| Steer | <kbd>A</kbd> <kbd>D</kbd> | Throttle / brake | <kbd>W</kbd> <kbd>S</kbd> |
| Parking brake | <kbd>Space</kbd> | Compression brake | <kbd>B</kbd> |
| Shift up / down | <kbd>Shift</kbd> <kbd>Ctrl</kbd> | Auto shift | <kbd>T</kbd> |
| Camera | <kbd>C</kbd> | Look back | <kbd>X</kbd> |
| Diff lock | <kbd>F</kbd> | Lift axle | <kbd>L</kbd> |
| Rear-steer trim | <kbd>Q</kbd> <kbd>E</kbd> | Reset | <kbd>P</kbd> |

The rear axles steer themselves. <kbd>Q</kbd> and <kbd>E</kbd> are only a trim,
for placing the tail by hand in a tight spot.

Gamepads work: left stick steers, triggers are the pedals. Steering is
deliberately rate-limited — a truck's box is about five turns lock to lock, and a
load this tall punishes fast corrections.

Release the parking brake to start. Take the switchback at eight.

## Layout

```
src/
  physics/     RigidBody, Constraints, Tire, Powertrain, Brakes, Vehicle, Rig,
               Trailers (selectable trailer and load configurations)
  world/       Route (spline, junctions, bridges, grades), Ground (terrain + grip)
  ai/          Traffic (IDM), Escort (blockades, leapfrog, radio)
  render/      Scene (sky, lighting, probe), Models, WorldMesh
  ui/          HUD, style
  core/        Input
test/          physics.test.js, mission.test.js
tools/         layout.mjs (load analysis), plus driving and browser harnesses
```

`tools/` holds the harnesses used to develop and verify the model — the static
load analysis the geometry comes from, acceleration/braking/cornering sweeps, a
convoy simulator, and Playwright scripts that drive the real page. They are the
reason the numbers above are measurements rather than intentions.

In the browser console, `game.jumpTo(metres, mph)` teleports the convoy anywhere
on the route — handy for going straight to the switchback or the grade.
