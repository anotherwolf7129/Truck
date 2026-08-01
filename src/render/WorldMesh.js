import {
  Group, Mesh, MeshStandardMaterial, MeshBasicMaterial, BufferGeometry,
  BufferAttribute, Vector3, CanvasTexture, RepeatWrapping, DoubleSide,
  BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry, InstancedMesh,
  Object3D, Color, SRGBColorSpace,
} from 'three';

const _p = new Vector3();
const _dummy = new Object3D();

/**
 * Road surface texture: asphalt with lane markings baked in.
 *
 * Drawn to a canvas rather than loaded, so the whole thing ships without
 * binary assets. The V axis runs across the road, so the markings land at
 * fixed lateral positions regardless of how the mesh is tiled along its length.
 */
function makeRoadTexture(halfWidth, laneWidth) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Asphalt base with noise so it does not read as flat grey.
  ctx.fillStyle = '#3b3d40';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  const toV = (lateral) => ((lateral + halfWidth) / (halfWidth * 2)) * canvas.height;

  // Shoulder edge lines
  ctx.fillStyle = '#e6e4dc';
  ctx.fillRect(0, toV(-laneWidth) - 2, canvas.width, 4);
  ctx.fillRect(0, toV(laneWidth) - 2, canvas.width, 4);

  // Centre line: double yellow, since a permit route like this is no-passing.
  ctx.fillStyle = '#d8b422';
  ctx.fillRect(0, toV(-0.16) - 2, canvas.width, 3);
  ctx.fillRect(0, toV(0.16) - 1, canvas.width, 3);

  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * Builds the visible world: the paved ribbon, the terrain it is cut into, and
 * the scenery that gives the route a sense of place and speed.
 */
export class WorldMesh {
  constructor(route, ground) {
    this.route = route;
    this.ground = ground;
    this.group = new Group();

    this.buildRoad();
    this.buildTerrain();
    this.buildScenery();
    this.buildBridges();
    this.buildJunctions();
  }

  /** The paved surface, swept along the route centreline. */
  buildRoad() {
    const route = this.route;
    const half = route.roadHalfWidth;
    const step = 4;
    const count = Math.floor(route.length / step);

    const positions = [];
    const uvs = [];
    const normals = [];
    const indices = [];

    for (let i = 0; i <= count; i++) {
      const s = i * step;
      const sample = route.at(s);
      for (let j = 0; j <= 1; j++) {
        const lateral = j === 0 ? -half : half;
        _p.copy(sample.position).addScaledVector(sample.lateral, lateral);
        // Match the camber the physics applies.
        positions.push(_p.x, _p.y - Math.abs(lateral) * 0.02, _p.z);
        normals.push(0, 1, 0);
        uvs.push(s / 8, j);
      }
      if (i < count) {
        // Wound counter-clockwise seen from above so the surface normal points
        // up. The other winding leaves the road backface-culled, and since the
        // terrain skirts stop at the pavement edge you end up looking straight
        // through the road at the sky.
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const tex = makeRoadTexture(half, route.laneWidth);
    tex.repeat.set(1, 1);
    const mat = new MeshStandardMaterial({ map: tex, roughness: 0.93, metalness: 0.02 });
    this.road = new Mesh(geo, mat);
    this.road.receiveShadow = true;
    this.group.add(this.road);
  }

  /**
   * Terrain around the corridor.
   *
   * Sampled from the same height function the physics uses, so what you see is
   * what the wheels will find. Built as a band that follows the route rather
   * than a giant grid, which keeps the vertex count sane over seven miles.
   */
  buildTerrain() {
    const route = this.route;
    const along = 12;
    const lanes = 22;
    const maxLateral = 260;
    const count = Math.floor(route.length / along);
    // The terrain is built as two skirts running outward from the edge of the
    // pavement. Carrying it across the road instead would leave two coplanar
    // surfaces fighting for the same depth values.
    const inner = route.roadHalfWidth - 0.15;

    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];

    const grass = new Color(0x6f8a45);
    const dry = new Color(0x9d9256);
    const rock = new Color(0x7a7369);
    const tmp = new Color();

    for (const side of [-1, 1]) {
    const base = positions.length / 3;

    for (let i = 0; i <= count; i++) {
      const s = i * along;
      const sample = route.at(s);
      for (let j = 0; j <= lanes; j++) {
        // Non-linear spacing: dense near the shoulder, coarse far away.
        const t = j / lanes;
        const offset = inner + Math.pow(t, 2.1) * (maxLateral - inner);
        const lateral = side * offset;
        _p.copy(sample.position).addScaledVector(sample.lateral, lateral);
        const h = this.ground.heightAt(_p.x, _p.z);
        positions.push(_p.x, h, _p.z);
        normals.push(0, 1, 0);

        // Tint by slope and elevation so the ridge reads differently from the
        // valley floor.
        const slope = Math.min(1, Math.abs(this.ground.heightAt(_p.x + 6, _p.z) - h) / 6);
        tmp.copy(grass).lerp(dry, Math.min(1, Math.max(0, (h - 20) / 90)));
        tmp.lerp(rock, slope * 0.75);
        colors.push(tmp.r, tmp.g, tmp.b);
      }
      if (i < count) {
        for (let j = 0; j < lanes; j++) {
          const a = base + i * (lanes + 1) + j;
          const b = a + (lanes + 1);
          // Wind each skirt so both faces point up.
          if (side > 0) indices.push(a, b, a + 1, b, b + 1, a + 1);
          else indices.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
    }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
    this.terrain = new Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.group.add(this.terrain);
  }

  /**
   * Trees, guardrail and power lines.
   *
   * Roadside detail is what gives speed a reference. Trees are instanced so
   * several thousand of them cost one draw call.
   */
  buildScenery() {
    const route = this.route;

    // --- Trees -------------------------------------------------------------
    const trunkGeo = new CylinderGeometry(0.22, 0.32, 3.4, 6);
    const foliageGeo = new ConeGeometry(2.1, 6.4, 7);
    const trunkMat = new MeshStandardMaterial({ color: 0x6b5138, roughness: 0.95 });
    const foliageMat = new MeshStandardMaterial({ color: 0x4d7233, roughness: 0.9 });

    const treeCount = 2600;
    const trunks = new InstancedMesh(trunkGeo, trunkMat, treeCount);
    const crowns = new InstancedMesh(foliageGeo, foliageMat, treeCount);
    trunks.castShadow = true;
    crowns.castShadow = true;

    let placed = 0;
    let guard = 0;
    while (placed < treeCount && guard++ < treeCount * 8) {
      const s = Math.random() * route.length;
      const side = Math.random() < 0.5 ? -1 : 1;
      const lateral = side * (route.roadHalfWidth + 8 + Math.pow(Math.random(), 0.7) * 150);
      route.positionAt(s, lateral, _p);
      const h = this.ground.heightAt(_p.x, _p.z);

      // Keep the corridor and the junction mouths clear.
      let blocked = false;
      for (const j of route.junctions) {
        if (Math.abs(j.s - s) < 40 && Math.sign(j.side) === Math.sign(side) && Math.abs(lateral) < 60) {
          blocked = true; break;
        }
      }
      if (blocked) continue;

      const scale = 0.7 + Math.random() * 0.9;
      _dummy.position.set(_p.x, h + 1.7 * scale, _p.z);
      _dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      trunks.setMatrixAt(placed, _dummy.matrix);

      _dummy.position.y = h + 5.4 * scale;
      _dummy.updateMatrix();
      crowns.setMatrixAt(placed, _dummy.matrix);
      placed++;
    }
    trunks.count = placed;
    crowns.count = placed;
    this.group.add(trunks, crowns);

    // --- Guardrail on the downhill side of the grade -----------------------
    const railMat = new MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.4 });
    const postMat = new MeshStandardMaterial({ color: 0x6b6f74, metalness: 0.6, roughness: 0.6 });
    const railGeo = new BoxGeometry(0.06, 0.32, 3.8);
    const postGeo = new BoxGeometry(0.10, 0.9, 0.10);

    const railSections = [];
    for (const g of route.grades ?? []) {
      railSections.push([g.start - 60, g.end + 60]);
    }
    for (const c of route.tightCorners) railSections.push([c.s - 120, c.s + 120]);

    let railTotal = 0;
    for (const [a, b] of railSections) railTotal += Math.floor((b - a) / 4);
    if (railTotal > 0) {
      const rails = new InstancedMesh(railGeo, railMat, railTotal);
      const posts = new InstancedMesh(postGeo, postMat, railTotal);
      rails.castShadow = true;
      let n = 0;
      for (const [a, b] of railSections) {
        for (let s = Math.max(0, a); s < Math.min(route.length, b) && n < railTotal; s += 4) {
          const sample = route.at(s);
          const lateral = route.roadHalfWidth + 1.0;
          route.positionAt(s, lateral, _p);
          const heading = Math.atan2(sample.tangent.x, sample.tangent.z);
          _dummy.position.set(_p.x, _p.y + 0.72, _p.z);
          _dummy.rotation.set(0, heading, 0);
          _dummy.scale.setScalar(1);
          _dummy.updateMatrix();
          rails.setMatrixAt(n, _dummy.matrix);
          _dummy.position.y = _p.y + 0.45;
          _dummy.updateMatrix();
          posts.setMatrixAt(n, _dummy.matrix);
          n++;
        }
      }
      rails.count = n;
      posts.count = n;
      this.group.add(rails, posts);
    }

    // --- Power lines, which the route is delivering a transformer to -------
    const poleMat = new MeshStandardMaterial({ color: 0x6b5844, roughness: 0.95 });
    const poleGeo = new CylinderGeometry(0.16, 0.22, 11, 6);
    const armGeo = new BoxGeometry(2.6, 0.14, 0.14);
    const poleCount = Math.floor(route.length / 90);
    const poles = new InstancedMesh(poleGeo, poleMat, poleCount);
    const arms = new InstancedMesh(armGeo, poleMat, poleCount);
    poles.castShadow = true;
    for (let i = 0; i < poleCount; i++) {
      const s = i * 90 + 40;
      route.positionAt(s, -(route.roadHalfWidth + 6), _p);
      const h = this.ground.heightAt(_p.x, _p.z);
      const heading = route.headingAt(s);
      _dummy.position.set(_p.x, h + 5.5, _p.z);
      _dummy.rotation.set(0, heading, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      poles.setMatrixAt(i, _dummy.matrix);
      _dummy.position.y = h + 10.2;
      _dummy.updateMatrix();
      arms.setMatrixAt(i, _dummy.matrix);
    }
    this.group.add(poles, arms);
  }

  /**
   * Bridges over the route.
   *
   * These are the reason the load's height is written on the permit. The deck
   * is placed at exactly the posted clearance above the road, so if the model
   * says it fits, it fits.
   */
  buildBridges() {
    const route = this.route;
    const concrete = new MeshStandardMaterial({ color: 0x8d8b85, roughness: 0.9, metalness: 0.05 });
    const girder = new MeshStandardMaterial({ color: 0x5c6066, roughness: 0.7, metalness: 0.5 });

    this.bridgeMeshes = [];
    for (const b of route.bridges) {
      const g = new Group();
      const sample = route.at(b.s);
      const width = 26;

      // Deck: its underside sits at the posted clearance.
      const deckThickness = 1.3;
      const deck = new Mesh(new BoxGeometry(width, deckThickness, b.span), concrete);
      deck.position.y = b.clearance + deckThickness / 2;
      deck.castShadow = true;
      deck.receiveShadow = true;
      g.add(deck);

      // Girders under the deck, kept above the clearance line.
      for (let i = -2; i <= 2; i++) {
        const gi = new Mesh(new BoxGeometry(width * 0.98, 0.22, 0.9), girder);
        gi.position.set(0, b.clearance + 0.12, i * (b.span / 5.5));
        g.add(gi);
      }

      // Abutments outside the road width.
      for (const side of [-1, 1]) {
        const pier = new Mesh(
          new BoxGeometry(4.5, b.clearance + 2, b.span + 1.5),
          concrete
        );
        pier.position.set(side * (route.roadHalfWidth + 3.4), (b.clearance + 2) / 2 - 1, 0);
        pier.castShadow = true;
        g.add(pier);
      }

      // Parapet
      for (const side of [-1, 1]) {
        const rail = new Mesh(new BoxGeometry(width, 1.0, 0.3), concrete);
        rail.position.set(0, b.clearance + deckThickness + 0.5, side * (b.span / 2));
        g.add(rail);
      }

      g.position.copy(sample.position);
      g.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
      g.userData.bridge = b;
      this.group.add(g);
      this.bridgeMeshes.push(g);

      // Clearance sign on the approach.
      this.group.add(this.makeClearanceSign(b));
    }
  }

  makeClearanceSign(bridge) {
    const route = this.route;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f2c200';
    ctx.fillRect(0, 0, 256, 200);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, 236, 180);
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.font = 'bold 34px Arial';
    ctx.fillText('CLEARANCE', 128, 66);
    ctx.font = 'bold 62px Arial';
    // Round to the inch first, then split, so 16.99 ft reads 17'-0" and not
    // the nonsense 16'-12".
    const totalInches = Math.round(bridge.clearance * 39.3701);
    const feet = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    ctx.fillText(`${feet}'-${inches}"`, 128, 140);

    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const sign = new Mesh(
      new PlaneGeometry(2.2, 1.7),
      new MeshBasicMaterial({ map: tex, side: DoubleSide })
    );
    const s = bridge.s - 55;
    route.positionAt(s, route.roadHalfWidth + 2.2, _p);
    sign.position.set(_p.x, _p.y + 2.6, _p.z);
    sign.rotation.y = route.headingAt(s) + Math.PI;

    const post = new Mesh(
      new CylinderGeometry(0.07, 0.07, 2.6, 6),
      new MeshStandardMaterial({ color: 0x777c82, metalness: 0.7, roughness: 0.5 })
    );
    post.position.set(_p.x, _p.y + 1.3, _p.z);

    const g = new Group();
    g.add(sign, post);
    return g;
  }

  /** Side roads at each junction, so a blockade has something to block. */
  buildJunctions() {
    const route = this.route;
    const asphalt = new MeshStandardMaterial({ color: 0x3b3d40, roughness: 0.94 });

    for (const j of route.junctions) {
      const sample = route.at(j.s);
      const dir = _p.copy(sample.lateral).multiplyScalar(j.side).normalize().clone();

      const length = 90;
      const road = new Mesh(new PlaneGeometry(7.4, length), asphalt);
      road.rotation.x = -Math.PI / 2;
      road.receiveShadow = true;

      const centre = sample.position.clone()
        .addScaledVector(dir, route.roadHalfWidth + length / 2);
      road.position.copy(centre);
      road.position.y = sample.position.y + 0.02;
      road.rotation.z = Math.atan2(dir.x, dir.z);
      this.group.add(road);

      // Stop line and a street name sign at the mouth.
      const stop = new Mesh(
        new PlaneGeometry(7.0, 0.5),
        new MeshBasicMaterial({ color: 0xe6e4dc })
      );
      stop.rotation.x = -Math.PI / 2;
      stop.rotation.z = Math.atan2(dir.x, dir.z);
      stop.position.copy(sample.position).addScaledVector(dir, route.roadHalfWidth + 4);
      stop.position.y = sample.position.y + 0.03;
      this.group.add(stop);

      this.group.add(this.makeStreetSign(j, sample, dir));
    }
  }

  makeStreetSign(junction, sample, dir) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1c5c2e';
    ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, 500, 84);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(junction.name.toUpperCase(), 256, 52);

    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const sign = new Mesh(
      new PlaneGeometry(2.6, 0.49),
      new MeshBasicMaterial({ map: tex, side: DoubleSide })
    );

    const pos = sample.position.clone()
      .addScaledVector(dir, this.route.roadHalfWidth + 2.5);
    sign.position.set(pos.x, pos.y + 3.0, pos.z);
    sign.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);

    const post = new Mesh(
      new CylinderGeometry(0.06, 0.06, 3.0, 6),
      new MeshStandardMaterial({ color: 0x777c82, metalness: 0.7, roughness: 0.5 })
    );
    post.position.set(pos.x, pos.y + 1.5, pos.z);

    const g = new Group();
    g.add(sign, post);
    return g;
  }
}
