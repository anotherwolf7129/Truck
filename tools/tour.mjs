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

const stops = [
  ['start',     40,    0,  'chase'],
  ['junction',  610,  22,  'chase'],
  ['bridge',    1855, 20,  'chase'],
  ['climb',     3400, 18,  'chase'],
  ['switchback',4790,  9,  'trailer'],
  ['descent',   5400, 20,  'chase'],
  ['cab',       7200, 25,  'cab'],
  ['cinema',    9000, 25,  'cinematic'],
];

for (const [name, s, mph, cam] of stops) {
  await page.evaluate(([s, mph, cam]) => {
    window.game.jumpTo(s, mph);
    window.game.cameraMode = cam;
    window.game._camInit = false;
  }, [s, mph, cam]);
  // Let the convoy settle into station and the rig onto its springs.
  await page.waitForTimeout(5500);
  await page.screenshot({ path: `${OUT}/tour-${name}.png` });
  const info = await page.evaluate(() => {
    const g = window.game;
    const blocked = g.convoy.blockades.filter(b=>b.active).map(b=>b.name);
    return `${g.cameraMode.padEnd(10)} s=${Math.round(g.convoyS)} ${g.rig.speedMph.toFixed(0)}mph roll=${g.rig.telemetry.rollover.toFixed(2)} blocked=[${blocked}] traffic=${g.traffic.vehicles.length} fps~${(1/ (g.render.renderer.info.render.frame? 0.25:0.25)).toFixed(0)}`;
  });
  console.log(name.padEnd(11), info);
}
await browser.close();
