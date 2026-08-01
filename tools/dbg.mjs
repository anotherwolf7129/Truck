import { Vector3 } from 'three';
import { Rig } from '../src/physics/Rig.js';
const g = { sample: () => ({ height: 0, normal: new Vector3(0,1,0), grip: 1 }) };
const rig = new Rig();
const dt = 1/200;
for (let i = 0; i <= 200; i++) {
  if (i % 20 === 0) {
    const t = rig.tractor, j = rig.jeep, l = rig.trailer;
    const w0 = t.wheels[0], w4 = t.wheels[2], lw = l.wheels[0];
    console.log(
      `i=${String(i).padStart(3)} ` +
      `tY=${t.body.position.y.toFixed(3)} jY=${j.body.position.y.toFixed(3)} lY=${l.body.position.y.toFixed(3)} | ` +
      `tVy=${t.body.velocity.y.toFixed(2)} lVy=${l.body.velocity.y.toFixed(2)} | ` +
      `steer=${(w0.load/1000).toFixed(0)}kN drive=${(w4.load/1000).toFixed(0)}kN lowboy=${(lw.load/1000).toFixed(0)}kN`
    );
  }
  rig.step(dt, g);
}
