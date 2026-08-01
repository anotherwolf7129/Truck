import { chromium } from 'playwright';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', 'shots');
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 790 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await page.click('#start-button');
await page.waitForTimeout(2500);

// Sit just before a junction so a unit has to run up and take it.
await page.evaluate(() => {
  window.game.jumpTo(8250, 20);
  window.game.cameraMode = 'cinematic';
  window.game._camInit = false;
});

// Watch for a police unit drawing level with the load and record the clearance.
let shots = 0;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => {
    const g = window.game;
    const tail = g.convoyS - g.rig.combinationLength;
    const loadLat = g.route.laneWidth * 0.5;
    let closest = null;
    for (const u of g.convoy.vehicles) {
      if (u.state === 'blocking') continue;
      if (u.s > tail - 25 && u.s < g.convoyS + 25) {
        const clear = Math.abs(u.lateral - loadLat) - (1.83 + u.width / 2);
        if (!closest || clear < closest.clear) {
          closest = { name: g.convoy.unitName(u), state: u.state, lat: +u.lateral.toFixed(2), clear: +clear.toFixed(2) };
        }
      }
    }
    return {
      closest,
      following: g.traffic.vehicles.filter((v) => v.state === 'following-convoy').length,
      convoyS: Math.round(g.convoyS),
    };
  });
  if (state.closest) {
    console.log(`alongside: ${state.closest.name} (${state.closest.state}) at lateral ${state.closest.lat} m, ` +
      `clearance ${state.closest.clear} m  | ${state.following} cars queued behind`);
    if (shots < 2) {
      await page.screenshot({ path: `${OUT}/passing-${shots}.png` });
      shots++;
    }
  }
}
await page.screenshot({ path: `${OUT}/passing-final.png` });
await browser.close();
