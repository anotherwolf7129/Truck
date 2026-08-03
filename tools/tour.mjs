import { chromium } from 'playwright';
const OUT = './shots';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
await page.waitForTimeout(2000);

// Named against the route's own survey marks, with an offset where the shot
// wants to be short of or past the thing itself. Stations written as numbers go
// stale the first time a corner moves.
const stops = [
  ['start',      ['onto Dock Street', -200],  0,  'chase'],
  ['dockturn',   ['onto Dock Street', 40],    8,  'chase'],
  ['junction',   ['Pier 9 Road', -20],       22,  'chase'],
  ['boulevard',  ['onto Harbor Boulevard', 40], 8, 'chase'],
  ['viaduct',    ['Beacon Hill viaduct', -55], 20, 'chase'],
  ['downtown',   ['Third Street', -60],       9,  'chase'],
  ['hill',       ['onto Prospect Hill', -120], 14, 'chase'],
  ['descent',    ['grade top', 300],         20,  'chase'],
  ['loopramp',   ['ramp', 40],                7,  'trailer'],
  ['freeway',    ['merge', 500],             40,  'chase'],
  ['cab',        ['Junction 14 overpass', -300], 40, 'cab'],
  ['exit',       ['exit', 120],              28,  'chase'],
  ['signal',     ['Meridian & Canal', -60],   9,  'hood'],
  ['gate',       ['substation turn', 30],     8,  'chase'],
  ['cinema',     ['Third Street', 120],      12,  'cinematic'],
];

for (const [name, [mark, offset], mph, cam] of stops) {
  const s = await page.evaluate(([m, o]) => window.game.route.survey.at(m) + o, [mark, offset]);
  await page.evaluate(([s, mph, cam]) => {
    const g = window.game;
    g.jumpTo(s, mph);
    g._camInit = false;
    g._chaseCamera ??= g.updateCamera;
    if (cam !== 'top') {
      g.updateCamera = g._chaseCamera;
      g.render.camera.up.set(0, 1, 0);   // the plan view leaves it pointing north
      g.cameraMode = cam;
      return;
    }
    // A fixed plan view, for checking the lane layout and the paint against the
    // numbers instead of guessing at them from a chase camera.
    const p = g.route.positionAt(s, 0, g.rig.tractor.body.position.clone());
    const heading = g.route.headingAt(s);
    g.updateCamera = function () {
      this.render.camera.position.set(p.x, p.y + 55, p.z);
      this.render.camera.up.set(Math.sin(heading), 0, Math.cos(heading));
      this.render.camera.lookAt(p.x, p.y, p.z);
      this.render.camera.updateProjectionMatrix();
    };
  }, [s, mph, cam]);
  // Let the convoy settle into station and the rig onto its springs.
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${OUT}/tour-${name}.png` });
  const info = await page.evaluate(() => {
    const g = window.game;
    const blocked = g.convoy.blockades.filter(b=>b.active).map(b=>b.name);
    const cross = g.convoy.blockades.reduce((n,b)=>n+(b.cross?b.cross.vehicles.length:0), 0);
    const sig = g.nextSignal ? `${g.nextSignal.phase}${g.nextSignal.held?'(held)':''}` : '-';
    return `s=${Math.round(g.convoyS)} ${g.rig.speedMph.toFixed(0)}mph lanes=${g.route.laneCountAt(g.convoyS)} limit=${g.speedLimitMph} roll=${g.rig.telemetry.rollover.toFixed(2)} blocked=[${blocked}] signal=${sig} traffic=${g.traffic.vehicles.length} cross=${cross} calls=${g.render.renderer.info.render.calls}`;
  });
  console.log(name.padEnd(11), info);
}
await browser.close();
