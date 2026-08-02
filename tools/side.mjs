/**
 * Which side of the road is the convoy on?
 *
 * Drops a plan view over the arterial, rotated so the direction of travel is
 * up the screen. In that view screen-right is the driver's right, so the lane
 * the load is in tells you directly which side of the road it is driving on.
 */
import { chromium } from 'playwright';

const OUT = process.argv[2] || './shots/side.png';
const S = Number(process.argv[3] || 9500);

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
await page.waitForTimeout(2000);

const report = await page.evaluate(([s]) => {
  const g = window.game;
  g.jumpTo(s, 14);
  const p = g.route.positionAt(s, 0, new g.route.samples[0].position.constructor());
  const heading = g.route.headingAt(s);
  g.updateCamera = function () {
    this.render.camera.position.set(p.x, p.y + 70, p.z);
    this.render.camera.up.set(Math.sin(heading), 0, Math.cos(heading));
    this.render.camera.lookAt(p.x, p.y, p.z);
    this.render.camera.updateProjectionMatrix();
  };
  return { s, heading, convoyLane: g.route.convoyLaneOffset(s) };
}, [S]);
await page.waitForTimeout(9000);

const probe = await page.evaluate(() => {
  const g = window.game;
  const cam = g.render.camera;
  // Camera-space X is screen-right. Project the route's lateral axis onto it.
  const sample = g.route.at(g.convoyS);
  const right = new sample.lateral.constructor();
  cam.updateMatrixWorld();
  right.set(sample.lateral.x, sample.lateral.y, sample.lateral.z);
  const camX = new right.constructor(
    cam.matrixWorld.elements[0], cam.matrixWorld.elements[1], cam.matrixWorld.elements[2]
  );
  return {
    lateralOnScreenRight: +right.dot(camX).toFixed(3),
    convoyLateral: +g.route.convoyLaneOffset(g.convoyS).toFixed(2),
    oncomingLateral: +g.route.laneOffsetAt(g.convoyS, -1, 0).toFixed(2),
  };
});
console.log(JSON.stringify({ ...report, ...probe }, null, 2));
await page.screenshot({ path: OUT });
await browser.close();
