import { chromium } from 'playwright';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport:{width:1100,height:620} });
await page.goto('http://127.0.0.1:5173/',{waitUntil:'networkidle',timeout:60000});
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
await page.waitForTimeout(3000);
await page.evaluate(()=>{ window.game.jumpTo(300, 15); window.game.cameraMode='chase'; window.game._camInit=false; });
await page.waitForTimeout(6000);

console.log(await page.evaluate(() => {
  const g = window.game, cam = g.render.camera, b = g.rig.tractor.body;
  const V = b.position.constructor;
  const probe = (localX, label) => {
    const p = b.localToWorld(new V(localX, 2, 0), new V());
    const s = p.clone().project(cam);
    return `${label.padEnd(22)} local x=${String(localX).padStart(4)}  ->  screen x=${s.x.toFixed(3)} (${s.x>0?'RIGHT half':'LEFT half'})`;
  };
  const out = [];
  out.push(probe(+8, 'LOCAL_RIGHT (+X) at'));
  out.push(probe(-8, 'negative X at'));
  // also: which way does the road curve / where is the lane the rig sits in
  const pr = g.route.project(b.position.x, b.position.z);
  out.push(`route lateral of rig = ${pr.lateral.toFixed(2)} m (code calls + "right of centreline")`);
  return out.join('\n');
}));
await browser.close();
