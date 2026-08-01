import { chromium } from 'playwright';
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
await page.waitForTimeout(6000);

console.log(await page.evaluate(() => {
  const g = window.game, r = g.rig;
  const wsum = (ws) => ws.reduce((a,w)=>a+w.load,0);
  const lines = [];
  lines.push(`comHeight=${r.trailer.comHeight.toFixed(3)}  trailerMountY=${r.trailer.wheels[0].position.y.toFixed(3)}`);
  lines.push(`weight=${(r.units.reduce((a,u)=>a+u.body.mass,0)*9.81/1000).toFixed(0)} kN   supported=${((wsum(r.tractor.wheels)+wsum(r.jeep.wheels)+wsum(r.trailer.wheels))/1000).toFixed(0)} kN`);
  for (const u of r.units) {
    lines.push(`${u.name.padEnd(8)} y=${u.body.position.y.toFixed(2)} load=${(wsum(u.wheels)/1000).toFixed(0)}kN chassisContact=${u.chassisContact.toFixed(3)}`);
    lines.push('   wheels: ' + u.wheels.map(w=>`${(w.load/1000).toFixed(0)}`).join(' '));
    lines.push('   comp:   ' + u.wheels.map(w=>`${((w.restLength-w.lastLength)*1000).toFixed(0)}`).join(' '));
  }
  lines.push(`ground at rig: ${g.ground.heightAt(r.tractor.body.position.x, r.tractor.body.position.z).toFixed(3)}`);
  lines.push(`sun.intensity=${g.render.sun.intensity.toFixed(2)} exposure=${g.render.renderer.toneMappingExposure.toFixed(2)} hemi=${g.render.hemi.intensity.toFixed(2)}`);
  return lines.join('\n');
}));
await browser.close();
