import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
await page.waitForTimeout(3000);

console.log(await page.evaluate(() => {
  const g = window.game, R = g.render;
  const out = [];
  const n = R.worldMeshNormals || null;
  const geo = g.worldMesh.terrain.geometry;
  const na = geo.getAttribute('normal');
  // average normal of the first few hundred vertices
  let ax=0, ay=0, az=0;
  for (let i=0;i<300;i++){ ax+=na.getX(i); ay+=na.getY(i); az+=na.getZ(i); }
  out.push(`terrain avg normal = (${(ax/300).toFixed(2)}, ${(ay/300).toFixed(2)}, ${(az/300).toFixed(2)})`);
  out.push(`terrain material side=${g.worldMesh.terrain.material.side} vertexColors=${g.worldMesh.terrain.material.vertexColors}`);
  out.push(`sun pos=(${R.sun.position.x.toFixed(0)},${R.sun.position.y.toFixed(0)},${R.sun.position.z.toFixed(0)}) target=(${R.sun.target.position.x.toFixed(0)},${R.sun.target.position.y.toFixed(0)},${R.sun.target.position.z.toFixed(0)}) intensity=${R.sun.intensity}`);
  out.push(`sun in scene: ${R.scene.children.includes(R.sun)}, target in scene: ${R.scene.children.includes(R.sun.target)}`);
  out.push(`scene.environment: ${R.scene.environment ? 'set' : 'NULL'}`);
  out.push(`camera pos=(${R.camera.position.x.toFixed(0)},${R.camera.position.y.toFixed(0)},${R.camera.position.z.toFixed(0)})`);
  out.push(`fog near=${R.scene.fog.near} far=${R.scene.fog.far}`);
  return out.join('\n');
}));

// Render variants to isolate the cause.
const variants = {
  'a-baseline': '',
  'b-no-shadows': 'game.render.renderer.shadowMap.enabled=false; game.render.scene.traverse(o=>{if(o.isMesh)o.castShadow=false});',
  'c-exposure-2': 'game.render.renderer.toneMappingExposure=2.0;',
  'd-no-env': 'game.render.scene.environment=null;',
  'e-hemi-only': 'game.render.sun.intensity=0; game.render.hemi.intensity=3;',
};
for (const [name, script] of Object.entries(variants)) {
  await page.evaluate(`(()=>{ ${script} })()`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/claude-0/-home-user-Truck/4c5628ff-a790-5a54-b19b-c32b20d2aa92/scratchpad/diag-${name}.png` });
  // reset by reloading state where needed
  if (name !== 'a-baseline') { await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(2500); await (await page.$('#start-button')).click(); await page.waitForTimeout(2500); }
}
console.log('variants rendered');
await browser.close();
