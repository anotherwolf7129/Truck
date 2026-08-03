# Development harnesses

These are the scripts used to build and verify the simulation. They are not part
of the game; they are how the numbers in the top-level README were measured.

Headless (plain `node tools/<name>.mjs`, no browser needed):

| | |
|---|---|
| `layout.mjs` | Static load analysis. The rig's axle positions, spring rates and coupling heights are derived from this, which is why the axle weights land on realistic permit numbers. |
| `drive.mjs` | Acceleration, braking distance and a steady-corner sweep. |
| `climb.mjs [station] [trailer]` | Holds a combination on the Prospect Hill climb and reports tractive force, slip and gearing. This is the harness that exposed the missing reflected driveline inertia, and later that a dual-lane platform cannot be moved by multiplying one tractor's torque. |
| `convoy.mjs` | Runs the escorts along the whole route and checks every junction is blocked before the load arrives. |
| `haul.mjs [trailer]` | Drives each trailer in the yard over the whole route with the mission autopilot and prints the permit officer's sheet: outcome, peak rollover, brake temperature, how much of the combination ended up off the pavement, and the clearance under the tightest structure. |
| `offtrack.mjs` | Fits the steady-state circle on a tight corner and reports how much of the swept path the trailer's rear steer actually saves. |
| `survey.mjs` | Walks the centreline and reports every corner on it — how far round, at what radius, at what advisory speed — plus the grades and where every junction, bridge and flagged corner actually landed. This is how the route is designed; a road you cannot measure the corners of is how it came to have three of them. |
| `perf.mjs` | Cost of the simulation per frame, broken down into physics, route queries, convoy and traffic. No browser: this is the part that runs on the main thread whatever the GPU is doing. |

Browser (need `npm i -D playwright` and a Chromium; set `CHROME_PATH` if it is
not on the default search path, and have `npm run dev` running):

| | |
|---|---|
| `shot.mjs <out.png> [ms]` | Screenshot plus a dump of live sim state. |
| `probe.mjs` | Per-wheel loads, compressions and lighting state from the running page. |
| `tour.mjs` | Jumps the convoy to each notable point on the route and screenshots it. |
| `side.mjs <out.png> [s]` | Plan view rotated so the direction of travel is up the screen, which is the quickest way to see which side of the road the load is actually on. |
| `frame.mjs` | Draw calls, triangles, shader programs and frame times at each notable point on the route. Run under software rasterisation the frame times mean nothing, but the draw calls and triangles are what they will be on real hardware. |

Screenshots land in `shots/`, which is gitignored.
