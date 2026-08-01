import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
await (await page.$('#start-button')).click();
await page.waitForTimeout(2500);
console.log(await page.evaluate(() => {
  const road = window.game.worldMesh.road;
  const m = road.material;
  const out = [];
  out.push(`map=${m.map ? 'set' : 'NULL'} image=${m.map && m.map.image ? m.map.image.width+'x'+m.map.image.height : 'none'}`);
  out.push(`colorSpace=${m.map && m.map.colorSpace}  repeat=${m.map && m.map.repeat.x},${m.map && m.map.repeat.y}`);
  out.push(`material.color=${m.color.getHexString()} roughness=${m.roughness} metalness=${m.metalness} envMapIntensity=${m.envMapIntensity}`);
  // Read back a few pixels of the source canvas.
  const c = m.map.image;
  const ctx = c.getContext('2d');
  const px = ctx.getImageData(32, 256, 1, 1).data;
  const edge = ctx.getImageData(32, 40, 1, 1).data;
  out.push(`canvas centre px=rgb(${px[0]},${px[1]},${px[2]})  near-edge px=rgb(${edge[0]},${edge[1]},${edge[2]})`);
  const uv = road.geometry.getAttribute('uv');
  out.push(`uv[0]=(${uv.getX(0).toFixed(2)},${uv.getY(0).toFixed(2)}) uv[1]=(${uv.getX(1).toFixed(2)},${uv.getY(1).toFixed(2)}) uv[2]=(${uv.getX(2).toFixed(2)},${uv.getY(2).toFixed(2)})`);
  return out.join('\n');
}));
await browser.close();
