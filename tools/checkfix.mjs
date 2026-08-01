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
await page.screenshot({ path: `${OUT}/start-screen.png` });

for (const [id, label] of [['lowboy4', '4axle'], ['lowboy6', '6axle'], ['girder8', '8axle']]) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.click(`.trailer-option[data-id="${id}"]`);
  await page.click('#start-button');
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    window.game.jumpTo(7600, 22);
    window.game.cameraMode = 'cinematic';
    window.game._camInit = false;
  });
  await page.waitForTimeout(9000);
  console.log(await page.evaluate(() => {
    const g = window.game;
    const b = g.rig.tractor.body;
    const pr = g.route.project(b.position.x, b.position.z);
    return `${g.rig.config.name.padEnd(24)} ${Math.round(g.rig.grossWeightLb).toLocaleString()} lb` +
      `  len ${g.rig.combinationLength.toFixed(0)}m  lane ${pr.lateral.toFixed(2)}m (+ = right)` +
      `  trailer wheels ${g.rig.trailer.wheels.length}`;
  }));
  await page.screenshot({ path: `${OUT}/rig-${label}.png` });
}

// Steering: hold D and see which way the lane offset moves.
await page.evaluate(() => {
  window.game.jumpTo(600, 18);
  window.game.cameraMode = 'chase';
  window.game._camInit = false;
});
await page.waitForTimeout(4000);
const read = () => page.evaluate(() => {
  const b = window.game.rig.tractor.body;
  return window.game.route.project(b.position.x, b.position.z).lateral;
});
const before = await read();
await page.keyboard.down('KeyD');
await page.waitForTimeout(22000);
await page.keyboard.up('KeyD');
const after = await read();
console.log(`\nholding D: lane offset ${before.toFixed(2)} -> ${after.toFixed(2)} m  => moved ${after > before ? 'RIGHT' : 'LEFT'}`);
await page.screenshot({ path: `${OUT}/steer-D.png` });

await browser.close();
