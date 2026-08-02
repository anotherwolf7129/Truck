/**
 * What one frame costs the renderer.
 *
 * Drives the real page and reports the renderer's own counters -- draw calls,
 * triangles, programs -- plus the frame times actually achieved, at a few points
 * on the route. Software rasterisation makes the absolute frame times here
 * meaningless as a target, but draw calls and triangles are what they will be on
 * real hardware, and they are what a browser's main thread spends its time on.
 *
 * Needs `npm run dev` running.
 */
import { chromium } from 'playwright';

/**
 * Where to measure. Taken from the route's own survey marks rather than written
 * down as numbers, so moving a corner does not silently move the measurement
 * somewhere else on the road.
 */
const WHERE = ['onto CH14', 'CH14 settled', 'CR9 turn', 'switchback', 'grade bottom', 'town line', 'Fairview Drive'];

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await (await page.$('#start-button')).click();
await page.waitForTimeout(3000);

const AT = await page.evaluate((names) =>
  names.map((n) => [n, window.game.route.survey.at(n)]), WHERE);

console.log('where            calls    tris   progs   objects   frame ms');
for (const [name, s] of AT) {
  await page.evaluate((at) => window.game.jumpTo(at, 25), s);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => new Promise((resolve) => {
    const g = window.game;
    const info = g.render.renderer.info;
    const times = [];
    let n = 0;
    const tick = () => {
      const t = performance.now();
      requestAnimationFrame(() => {
        times.push(performance.now() - t);
        if (++n < 40) tick();
        else {
          times.sort((a, b) => a - b);
          let objects = 0;
          g.render.scene.traverse((o) => { if (o.isMesh) objects++; });
          resolve({
            calls: info.render.calls,
            tris: info.render.triangles,
            programs: info.programs.length,
            objects,
            median: times[times.length >> 1],
          });
        }
      });
    };
    tick();
  }));
  console.log(
    name.padEnd(16)
    + String(r.calls).padStart(5)
    + String((r.tris / 1000).toFixed(0) + 'k').padStart(8)
    + String(r.programs).padStart(8)
    + String(r.objects).padStart(10)
    + r.median.toFixed(1).padStart(11)
  );
}
await browser.close();
