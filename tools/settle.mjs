import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
for (let i=0;i<8;i++){
  await page.waitForTimeout(2500);
  console.log(await page.evaluate(() => {
    const r = window.game.rig;
    const sup = r.units.reduce((a,u)=>a+u.wheels.reduce((b,w)=>b+w.load,0),0);
    const w = r.units.reduce((a,u)=>a+u.body.mass,0)*9.81;
    const vy = r.units.map(u=>u.body.velocity.y.toFixed(3)).join(',');
    return `t=${window.game.elapsed.toFixed(1)}s supported=${(sup/1000).toFixed(0)}kN (${(sup/w*100).toFixed(0)}%) vY=[${vy}] tractorRoll=${(r.tractor.rollAngle*57.3).toFixed(2)}deg`;
  }));
}
await browser.close();
