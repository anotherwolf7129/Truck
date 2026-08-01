import { chromium } from 'playwright';
import path from 'node:path';
const OUT = path.resolve(import.meta.dirname, '..', 'shots');
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport:{width:1100,height:620} });
await page.goto('http://127.0.0.1:5173/',{waitUntil:'networkidle',timeout:60000});
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
await page.waitForTimeout(1500);

for (const [key, label] of [['KeyD','D-steer-right'], ['KeyA','A-steer-left']]) {
  await page.evaluate(() => { window.game.jumpTo(600, 20); window.game.cameraMode='chase'; window.game._camInit=false; });
  await page.waitForTimeout(4000);
  // Hold the key for a while of *simulated* time.
  await page.keyboard.down(key);
  await page.waitForTimeout(26000);
  await page.keyboard.up(key);

  const r = await page.evaluate(() => {
    const g = window.game, cam = g.render.camera, b = g.rig.tractor.body;
    // Where is the truck on screen, and which way is it pointing relative to the camera?
    const p = b.position.clone().project(cam);
    const fwd = b.localToWorldDir(new THREE_V(0,0,1));
    return { screenX: +p.x.toFixed(3), steerInput: +g.input.steer.toFixed(2),
             steerAngleDeg: +(g.rig.steerAngle*57.3).toFixed(1),
             lateral: +g.route.project(b.position.x,b.position.z).lateral.toFixed(2) };
    function THREE_V(x,y,z){ return new (b.position.constructor)(x,y,z); }
  });
  console.log(`${label}: input=${r.steerInput} roadWheel=${r.steerAngleDeg}deg  lane offset=${r.lateral} m  (+ = right of centreline)`);
  await page.screenshot({ path: `${OUT}/${label}.png` });
}
await browser.close();
