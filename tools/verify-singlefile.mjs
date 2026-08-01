import { chromium } from 'playwright';
import path from 'node:path';

const file = 'file://' + path.resolve(import.meta.dirname, '..', 'heavy-haul.html');
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });

console.log('loading', file);
await page.goto(file, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(4000);

const started = await page.evaluate(() => !!document.querySelector('#start-screen.visible'));
console.log('start screen shown:', started);
if (errors.length) { console.log('EARLY ERRORS:\n' + errors.slice(0,10).join('\n')); }
const loadingHtml = await page.evaluate(() => document.querySelector('#loading')?.innerHTML?.slice(0,600));
console.log('loading panel:', loadingHtml);
const btn = await page.$('#start-button');
if (btn && started) await btn.click();
await page.waitForTimeout(6000);

// Actually drive it: release the parking brake and get rolling.
await page.evaluate(() => { window.game.jumpTo(8330, 20); });
await page.waitForTimeout(30000);
const state = await page.evaluate(() => {
  const g = window.game;
  if (!g) return { error: 'game never initialised' };
  return {
    gross: Math.round(g.rig.grossWeightLb),
    psi: Math.round(g.rig.air.psi),
    gear: g.rig.powertrain.gearLabel,
    escorts: g.convoy.vehicles.length,
    triangles: g.render.renderer.info.render.triangles,
    drawCalls: g.render.renderer.info.render.calls,
    radio: g.convoy.radio.messages.length,
    mph: +g.rig.speedMph.toFixed(0),
    blocked: g.convoy.blockades.filter(b=>b.active).map(b=>b.name),
    rollover: +g.rig.telemetry.rollover.toFixed(2),
  };
});
console.log(JSON.stringify(state));
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0,10).join('\n') : 'no errors');
await page.screenshot({ path: path.resolve(import.meta.dirname, '..', 'shots', 'singlefile.png') });
await browser.close();
