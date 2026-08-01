import { chromium } from 'playwright';

const out = process.argv[2] || 'shot.png';
const waitMs = Number(process.argv[3] || 6000);
const script = process.argv[4] || '';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on('console', m => { if (m.type()==='error') errors.push('CONSOLE '+m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR '+e.message));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// Dismiss the start screen and begin the loop.
const btn = await page.$('#start-button');
if (btn) await btn.click();
await page.waitForTimeout(waitMs);

if (script) await page.evaluate(script);

const state = await page.evaluate(() => {
  const g = window.game;
  if (!g) return { error: 'game not on window' };
  return {
    mph: +g.rig.speedMph.toFixed(1),
    gear: g.rig.powertrain.gearLabel,
    rpm: Math.round(g.rig.powertrain.rpm),
    psi: +g.rig.air.psi.toFixed(0),
    park: g.rig.air.parkingBrake,
    convoyS: Math.round(g.convoyS),
    tractorY: +g.rig.tractor.body.position.y.toFixed(2),
    trailerY: +g.rig.trailer.body.position.y.toFixed(2),
    rollover: +g.rig.telemetry.rollover.toFixed(2),
    escorts: g.convoy.vehicles.map(v => `${g.convoy.unitName(v)}:${v.state}@${Math.round(v.s-g.convoyS)}m`),
    traffic: g.traffic.vehicles.length,
    sceneChildren: g.render.scene.children.length,
    drawCalls: g.render.renderer.info.render.calls,
    triangles: g.render.renderer.info.render.triangles,
    camera: g.cameraMode,
  };
});

console.log(JSON.stringify(state, null, 2));
if (errors.length) console.log('\n--- ERRORS ---\n' + errors.slice(0,20).join('\n'));
else console.log('\nno console errors');

await page.screenshot({ path: out });
await browser.close();
