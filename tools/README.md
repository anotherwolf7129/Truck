# Development harnesses

These are the scripts used to build and verify the simulation. They are not part
of the game; they are how the numbers in the top-level README were measured.

Headless (plain `node tools/<name>.mjs`, no browser needed):

| | |
|---|---|
| `layout.mjs` | Static load analysis. The rig's axle positions, spring rates and coupling heights are derived from this, which is why the axle weights land on realistic permit numbers. |
| `drive.mjs` | Acceleration, braking distance and a steady-corner sweep. |
| `climb.mjs` | Holds the rig on the 7% grade and reports tractive force, slip and gearing. This is the harness that exposed the missing reflected driveline inertia. |
| `convoy.mjs` | Runs the escorts along the whole route and checks every junction is blocked before the load arrives. |
| `offtrack.mjs` | Fits the steady-state circle on a tight corner and reports how much of the swept path the lowboy's rear steer actually saves. |

Browser (need `npm i -D playwright` and a Chromium; set `CHROME_PATH` if it is
not on the default search path, and have `npm run dev` running):

| | |
|---|---|
| `shot.mjs <out.png> [ms]` | Screenshot plus a dump of live sim state. |
| `probe.mjs` | Per-wheel loads, compressions and lighting state from the running page. |
| `tour.mjs` | Jumps the convoy to each notable point on the route and screenshots it. |
| `side.mjs <out.png> [s]` | Plan view rotated so the direction of travel is up the screen, which is the quickest way to see which side of the road the load is actually on. |

Screenshots land in `shots/`, which is gitignored.
