import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
page.on('console', m => { if(m.type()==='error'||m.type()==='warning') console.log(m.type().toUpperCase(), m.text().slice(0,200)); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
await page.waitForTimeout(2500);

console.log(await page.evaluate(async () => {
  const g = window.game, R = g.render;
  const THREE = await import('/node_modules/three/build/three.module.js');
  const out = [];

  const t = g.worldMesh.terrain;
  out.push(`terrain visible=${t.visible} frustumCulled=${t.frustumCulled} matWorld.y=${t.matrixWorld.elements[13]}`);
  const col = t.geometry.getAttribute('color');
  out.push(`vertex color[0] = ${col.getX(0).toFixed(3)}, ${col.getY(0).toFixed(3)}, ${col.getZ(0).toFixed(3)}`);
  out.push(`material.color = ${t.material.color.getHexString()}  envMapIntensity=${t.material.envMapIntensity}`);
  out.push(`renderer.info: calls=${R.renderer.info.render.calls} tris=${R.renderer.info.render.triangles}`);
  out.push(`ColorManagement.enabled=${THREE.ColorManagement.enabled}`);
  out.push(`outputColorSpace=${R.renderer.outputColorSpace} toneMapping=${R.renderer.toneMapping}`);

  // Does an unlit copy of the terrain show up?
  R.scene.add(new THREE.AmbientLight(0xffffff, 5));
  out.push('added AmbientLight(5)');
  return out.join('\n');
}));

await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/claude-0/-home-user-Truck/4c5628ff-a790-5a54-b19b-c32b20d2aa92/scratchpad/diag-ambient.png' });

// Now swap terrain to a basic material to prove geometry is on screen.
await page.evaluate(async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const g = window.game;
  g.worldMesh.terrain.material = new THREE.MeshBasicMaterial({ vertexColors: true });
  g.worldMesh.road.material = new THREE.MeshBasicMaterial({ map: g.worldMesh.road.material.map });
});
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/claude-0/-home-user-Truck/4c5628ff-a790-5a54-b19b-c32b20d2aa92/scratchpad/diag-basic.png' });
console.log('done');
await browser.close();
