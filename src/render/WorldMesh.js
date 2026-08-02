import {
  Group, Mesh, MeshStandardMaterial, MeshBasicMaterial, BufferGeometry,
  BufferAttribute, Vector3, CanvasTexture, RepeatWrapping, DoubleSide,
  BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry, InstancedMesh,
  Object3D, Color, SRGBColorSpace,
} from 'three';
import { Weld } from './Models.js';

const _p = new Vector3();
const _q = new Vector3();
const _q2 = new Vector3();
const _dummy = new Object3D();

/** Lit and unlit lens colours for a signal head. */
const SIGNAL_LIT = {
  red: new Color(0xff2213).multiplyScalar(1.5),
  amber: new Color(0xffa415).multiplyScalar(1.5),
  green: new Color(0x1ee060).multiplyScalar(1.5),
};
const SIGNAL_DARK = {
  red: new Color(0x3a0f0c),
  amber: new Color(0x3a2a0a),
  green: new Color(0x0c2c17),
};

/**
 * Road surface texture: plain asphalt.
 *
 * The lane markings used to be baked into this, which works exactly as long as
 * the road is one width for its whole length. It is not -- the route runs from a
 * two-lane county highway to a five-lane arterial -- so the paint is geometry
 * now and this is just the surface it is painted on. The UVs are in metres, so
 * the grain stays the same size whether the road is 12 m wide or 22.
 */
function makeAsphaltTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#3b3d40';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * How much route one chunk of scenery covers, in metres.
 *
 * Everything static is built in chunks this long so that the renderer can throw
 * it away. Three.js culls by an object's bounding sphere, and an instanced mesh
 * carrying every tree on a seven-mile route has a bounding sphere seven miles
 * across -- which is never off screen, so all 2,600 of them were submitted every
 * frame, and again for the shadow map, however far away they were. The same was
 * true of the terrain, the guardrail, the power poles and the whole town. That
 * is a couple of hundred thousand triangles of work per frame with a known
 * answer of "not visible".
 *
 * Chunking is a trade: more draw calls when a lot is on screen, far fewer
 * triangles the rest of the time. At 320 m the chunk is comfortably smaller than
 * what the fog hides, so only a handful are ever live at once.
 */
const CHUNK = 320;

/**
 * Instances of one geometry, bucketed along the route so they can be culled.
 *
 * Collects matrices while the world is being built and emits one InstancedMesh
 * per chunk that actually got any, sharing the geometry and material between
 * them. A chunk with nothing in it costs nothing.
 */
class InstanceSet {
  constructor(geometry, material, { castShadow = false, receiveShadow = false } = {}) {
    this.geometry = geometry;
    this.material = material;
    this.castShadow = castShadow;
    this.receiveShadow = receiveShadow;
    this.buckets = new Map();
  }

  /** Records one instance, filed by where on the route it stands. */
  push(s, matrix, color = null) {
    const key = Math.floor(s / CHUNK);
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = []));
    bucket.push({ matrix: matrix.clone(), color: color ? color.clone() : null });
  }

  /** Emits the meshes. Returns them so the caller can keep a handle if it wants. */
  build(parent) {
    const out = [];
    for (const bucket of this.buckets.values()) {
      const mesh = new InstancedMesh(this.geometry, this.material, bucket.length);
      mesh.castShadow = this.castShadow;
      mesh.receiveShadow = this.receiveShadow;
      bucket.forEach((entry, i) => {
        mesh.setMatrixAt(i, entry.matrix);
        if (entry.color) mesh.setColorAt(i, entry.color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      parent.add(mesh);
      out.push(mesh);
    }
    return out;
  }
}

/**
 * Every painted mark of one colour, bucketed along the route.
 *
 * The paint is geometry rather than a texture, because the road is not one width
 * for its whole length. As a single mesh that was a hundred thousand triangles
 * with a route-long bounding sphere -- drawn in full, always. Chunked, only the
 * paint you can see is submitted.
 *
 * Lines are emitted as a strip of quads that has to survive crossing a chunk
 * boundary, so the last pair of vertices is carried into the new chunk and the
 * two meet without a gap.
 */
class PaintSet {
  constructor(color) {
    this.color = color;
    this.chunks = new Map();
    this._open = false;
    this._last = null;
    this._lastKey = null;
  }

  chunk(s) {
    const key = Math.floor(s / CHUNK);
    let c = this.chunks.get(key);
    if (!c) this.chunks.set(key, (c = { positions: [], indices: [], prev: -1 }));
    return { key, c };
  }

  /** Continues a painted line with the pair of points across it at `s`. */
  strip(s, a, b) {
    const { key, c } = this.chunk(s);
    if (this._lastKey !== key) {
      c.prev = -1;
      if (this._open && this._last) {
        c.prev = c.positions.length / 3;
        c.positions.push(...this._last);
      }
      this._lastKey = key;
    }
    const base = c.positions.length / 3;
    c.positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    if (c.prev >= 0) {
      c.indices.push(c.prev, c.prev + 1, base, c.prev + 1, base + 1, base);
    }
    c.prev = base;
    this._last = [a.x, a.y, a.z, b.x, b.y, b.z];
    this._open = true;
  }

  /** Ends the current line, so the next point does not join onto it. */
  breakStrip() {
    this._open = false;
    this._last = null;
    this._lastKey = null;
    for (const c of this.chunks.values()) c.prev = -1;
  }

  /** One flat quad, corners given in order round the face. */
  quad(s, a, b, c2, d) {
    const { c } = this.chunk(s);
    const base = c.positions.length / 3;
    for (const p of [a, b, c2, d]) c.positions.push(p.x, p.y, p.z);
    c.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(parent) {
    // Paint sits on the road, not above it, so it is pushed toward the camera in
    // depth rather than lifted into the air where it would shadow oddly and
    // float at a distance.
    const mat = new MeshBasicMaterial({ color: this.color });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -4;
    mat.polygonOffsetUnits = -6;

    for (const c of this.chunks.values()) {
      if (!c.indices.length) continue;
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(c.positions), 3));
      geo.setIndex(c.indices);
      geo.computeVertexNormals();
      parent.add(new Mesh(geo, mat));
    }
  }
}

/**
 * Builds the visible world: the paved ribbon and its markings, the terrain it is
 * cut into, the town it runs through, and the signals that run the town.
 */
export class WorldMesh {
  constructor(route, ground) {
    this.route = route;
    this.ground = ground;
    this.group = new Group();

    // Every painted mark on the route goes into these two vertex sets and comes
    // out as two meshes -- one white, one yellow. The lane lines, the stop bars,
    // the crosswalks at each signal and the stop lines across each side road are
    // all the same thing: flat paint on the road surface. Built as individual
    // meshes they were a hundred and ten objects to cull and submit for what is
    // two draw calls' worth of geometry.
    this.paint = {
      white: new PaintSet(0xe8e6de),
      yellow: new PaintSet(0xd8b422),
    };

    this.buildRoad();
    this.buildMarkings();
    this.buildTerrain();
    this.buildScenery();
    this.buildTown();
    this.buildBridges();
    this.buildJunctions();
    this.buildPaint();
    this.buildSignals();
    this.buildSigns();
  }

  /** Height of the paved surface at a point across the road, camber included. */
  surfaceY(sample, lateral) {
    return sample.position.y - Math.abs(lateral) * 0.02;
  }

  /** The paved surface, swept along the route centreline. */
  buildRoad() {
    const route = this.route;
    const step = 4;
    const count = Math.floor(route.length / step);

    const positions = [];
    const uvs = [];
    const normals = [];
    const indices = [];

    for (let i = 0; i <= count; i++) {
      const s = i * step;
      const sample = route.at(s);
      const half = route.halfWidthAt(s);
      for (let j = 0; j <= 1; j++) {
        const lateral = j === 0 ? -half : half;
        _p.copy(sample.position).addScaledVector(sample.lateral, lateral);
        // Match the camber the physics applies.
        positions.push(_p.x, this.surfaceY(sample, lateral), _p.z);
        normals.push(0, 1, 0);
        uvs.push(s / 8, lateral / 8);
      }
      if (i < count) {
        // Wound counter-clockwise seen from above so the surface normal points
        // up. The other winding leaves the road backface-culled, and since the
        // terrain skirts stop at the pavement edge you end up looking straight
        // through the road at the sky. Which way round that is depends on which
        // way the route's lateral axis points, so this follows it.
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new MeshStandardMaterial({
      map: makeAsphaltTexture(), roughness: 0.93, metalness: 0.02,
    });
    this.road = new Mesh(geo, mat);
    this.road.receiveShadow = true;
    this.group.add(this.road);
  }

  // ---------------------------------------------------------------------------
  // Lane markings
  // ---------------------------------------------------------------------------

  /**
   * Every line on the road, built as geometry laid on the surface.
   *
   * A stripe is a lateral offset that varies with arc length plus a rule for
   * when it exists at all, which covers the whole route with four declarations:
   * the two edge lines follow the pavement wherever it goes, the centreline is a
   * double yellow until the turn lane opens and a pair of turn-lane lines after
   * that, and the lane dividers exist exactly where there is a second lane to
   * divide.
   */
  buildMarkings() {
    const route = this.route;
    const white = this.paint.white;
    const yellow = this.paint.yellow;

    // Edge lines, just inside the pavement edge.
    this.addStripe(white, {
      offsetAt: (s) => route.edgeOffsetAt(s) - 0.12,
      width: 0.14,
    });
    this.addStripe(white, {
      offsetAt: (s) => -route.edgeOffsetAt(s) + 0.12,
      width: 0.14,
    });

    // Centreline. With no turn lane this is the familiar double yellow of a
    // no-passing rural highway; with one it becomes the turn lane's markings,
    // solid on the outside and dashed on the inside.
    const plain = (s) => route.medianAt(s) < 1.0;
    for (const side of [-1, 1]) {
      this.addStripe(yellow, {
        offsetAt: (s) => (plain(s) ? side * 0.17 : side * route.medianAt(s) * 0.5),
        width: 0.13,
      });
      this.addStripe(yellow, {
        offsetAt: (s) => side * (route.medianAt(s) * 0.5 - 0.42),
        width: 0.13,
        existsAt: (s) => !plain(s),
        dash: [3, 3],
      });
    }

    // Lane dividers: one for every extra lane, on both sides of the road.
    for (let k = 1; k < route.corridor.maxLanes; k++) {
      for (const dir of [-1, 1]) {
        this.addStripe(white, {
          offsetAt: (s) => dir * (route.medianAt(s) * 0.5 + k * route.laneWidth),
          width: 0.13,
          existsAt: (s) => route.laneCountAt(s) > k,
          dash: [3, 9],
        });
      }
    }

  }

  /** Emits the accumulated paint, chunk by chunk. */
  buildPaint() {
    this.markings = new Group();
    this.paint.white.build(this.markings);
    this.paint.yellow.build(this.markings);
    this.group.add(this.markings);
  }

  /**
   * A rectangle of paint lying on the road, centred on an arc length and a
   * lateral offset.
   *
   * @param length metres along the road
   * @param width  metres across it
   */
  addMark(target, s, lateral, length, width) {
    const sample = this.route.at(s, this._markSample ??= {});
    const halfL = length * 0.5;
    const halfW = width * 0.5;
    const y = this.surfaceY(sample, lateral) + 0.004;
    const corner = (dl, dw) => {
      const p = _q.copy(sample.position)
        .addScaledVector(sample.tangent, dl)
        .addScaledVector(sample.lateral, lateral + dw);
      return { x: p.x, y, z: p.z };
    };
    target.quad(s,
      corner(-halfL, -halfW), corner(halfL, -halfW),
      corner(halfL, halfW), corner(-halfL, halfW));
  }

  /** A rectangle of paint on an arbitrary flat patch, for marks on a side road. */
  addPatch(target, s, centre, axisU, axisV, halfU, halfV, y) {
    const corner = (du, dv) => {
      const p = _q.copy(centre).addScaledVector(axisU, du).addScaledVector(axisV, dv);
      return { x: p.x, y, z: p.z };
    };
    target.quad(s,
      corner(-halfU, -halfV), corner(halfU, -halfV),
      corner(halfU, halfV), corner(-halfU, halfV));
  }

  /**
   * Emits one painted line into a vertex set.
   *
   * @param offsetAt  lateral offset of the line's centre at an arc length
   * @param width     metres
   * @param existsAt  optional predicate: is there a line here at all
   * @param dash      optional [on, off] metres
   */
  addStripe(target, { offsetAt, width, existsAt = null, dash = null, from = 0, to = null, step = null }) {
    const route = this.route;
    const end = to ?? route.length;
    const half = width * 0.5;
    // A solid line only needs enough vertices to follow the curve, and the route
    // is sampled every five metres, so four is plenty. A dashed one is sampled
    // finely enough to land its dashes where they belong.
    const advance = step ?? (dash ? 2 : 4);
    const point = { x: 0, y: 0, z: 0 };
    const other = { x: 0, y: 0, z: 0 };

    target.breakStrip();
    for (let s = from; s <= end; s += advance) {
      const on = (!existsAt || existsAt(s))
        && (!dash || (s % (dash[0] + dash[1])) < dash[0]);
      if (!on) { target.breakStrip(); continue; }

      const sample = route.at(s, this._stripeSample ??= {});
      const offset = offsetAt(s);
      const out = [point, other];
      [-half, half].forEach((edge, i) => {
        const lateral = offset + edge;
        _p.copy(sample.position).addScaledVector(sample.lateral, lateral);
        out[i].x = _p.x;
        out[i].y = this.surfaceY(sample, lateral) + 0.004;
        out[i].z = _p.z;
      });
      target.strip(s, point, other);
    }
    target.breakStrip();
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
    // Sixteen metres between stations and fourteen samples out to the edge of
    // the band. This used to be twelve and twenty-two, which put a hundred and
    // forty thousand triangles of grass verge on screen at once -- most of it
    // several kilometres away and behind the haze. The spacing is non-linear
    // across the band, so the detail that was lost is all in the distance.
    const along = 16;
    const lanes = 14;
    const maxLateral = 260;
    const perChunk = Math.max(2, Math.round(CHUNK / along));
    const count = Math.floor(route.length / along);

    const grass = new Color(0x6f8a45);
    const dry = new Color(0x9d9256);
    const rock = new Color(0x7a7369);
    const tmp = new Color();

    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
    this.terrain = [];

    // One mesh per chunk of route. As a single mesh this was ninety thousand
    // triangles with a bounding sphere the length of the route, so it was drawn
    // in full from the yard to the substation whatever was actually on screen.
    // The chunks overlap by a station so there is no crack at the seam.
    for (let from = 0; from < count; from += perChunk) {
      const to = Math.min(count, from + perChunk);
      const mesh = this.terrainChunk(from, to, {
        along, lanes, maxLateral, grass, dry, rock, tmp, mat,
      });
      this.terrain.push(mesh);
      this.group.add(mesh);
    }
  }

  /** One chunk of the terrain skirt, from station `from` to station `to`. */
  terrainChunk(from, to, { along, lanes, maxLateral, grass, dry, rock, tmp, mat }) {
    const route = this.route;
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];
    const count = to - from;

    for (const side of [-1, 1]) {
    const base = positions.length / 3;

    for (let i = 0; i <= count; i++) {
      const s = (from + i) * along;
      const sample = route.at(s);
      // The terrain is built as two skirts running outward from the edge of the
      // pavement, which is now a different distance out at every station.
      // Carrying it across the road instead would leave two coplanar surfaces
      // fighting for the same depth values.
      const inner = route.halfWidthAt(s) - 0.15;
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
          if (side > 0) indices.push(a, a + 1, b, b, a + 1, b + 1);
          else indices.push(a, b, a + 1, b, b + 1, a + 1);
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

    const mesh = new Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  /** True if anything at this station would be sitting in a junction mouth. */
  nearJunction(s, side, margin = 34) {
    for (const j of this.route.junctions) {
      if (Math.abs(j.s - s) > margin) continue;
      if (j.crossing || Math.sign(j.side) === Math.sign(side)) return true;
    }
    return false;
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
    const trunks = new InstanceSet(trunkGeo, trunkMat, { castShadow: true });
    const crowns = new InstanceSet(foliageGeo, foliageMat, { castShadow: true });

    let placed = 0;
    let guard = 0;
    while (placed < treeCount && guard++ < treeCount * 8) {
      const s = Math.random() * route.length;
      const side = Math.random() < 0.5 ? -1 : 1;
      const suburban = route.kindAt(s) === 'suburban';
      // Town gets street trees rather than woods: close in, and only every so
      // often, so the houses behind them can still be seen.
      if (suburban && Math.random() > 0.25) continue;
      const lateral = suburban
        ? side * (route.halfWidthAt(s) + 3.4 + Math.random() * 1.6)
        : side * (route.halfWidthAt(s) + 8 + Math.pow(Math.random(), 0.7) * 150);
      route.positionAt(s, lateral, _p);
      const h = this.ground.heightAt(_p.x, _p.z);

      // Keep the corridor and the junction mouths clear.
      if (this.nearJunction(s, side, 40) && Math.abs(lateral) < 60) continue;

      const scale = suburban ? 0.55 + Math.random() * 0.35 : 0.7 + Math.random() * 0.9;
      _dummy.position.set(_p.x, h + 1.7 * scale, _p.z);
      _dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      trunks.push(s, _dummy.matrix);

      _dummy.position.y = h + 5.4 * scale;
      _dummy.updateMatrix();
      crowns.push(s, _dummy.matrix);
      placed++;
    }
    trunks.build(this.group);
    crowns.build(this.group);

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

    const rails = new InstanceSet(railGeo, railMat, { castShadow: true });
    const posts = new InstanceSet(postGeo, postMat);
    for (const [a, b] of railSections) {
      for (let s = Math.max(0, a); s < Math.min(route.length, b); s += 4) {
        const lateral = route.halfWidthAt(s) + 1.0;
        route.positionAt(s, lateral, _p);
        const heading = route.headingAt(s);
        _dummy.position.set(_p.x, _p.y + 0.72, _p.z);
        _dummy.rotation.set(0, heading, 0);
        _dummy.scale.setScalar(1);
        _dummy.updateMatrix();
        rails.push(s, _dummy.matrix);
        _dummy.position.y = _p.y + 0.45;
        _dummy.updateMatrix();
        posts.push(s, _dummy.matrix);
      }
    }
    rails.build(this.group);
    posts.build(this.group);

    // --- Power lines, which the route is delivering a transformer to -------
    const poleMat = new MeshStandardMaterial({ color: 0x6b5844, roughness: 0.95 });
    const poleGeo = new CylinderGeometry(0.16, 0.22, 11, 6);
    const armGeo = new BoxGeometry(2.6, 0.14, 0.14);
    const poleCount = Math.floor(route.length / 90);
    const poles = new InstanceSet(poleGeo, poleMat, { castShadow: true });
    const arms = new InstanceSet(armGeo, poleMat);
    for (let i = 0; i < poleCount; i++) {
      const s = i * 90 + 40;
      route.positionAt(s, -(route.halfWidthAt(s) + 6), _p);
      const h = this.ground.heightAt(_p.x, _p.z);
      const heading = route.headingAt(s);
      _dummy.position.set(_p.x, h + 5.5, _p.z);
      _dummy.rotation.set(0, heading, 0);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      poles.push(s, _dummy.matrix);
      _dummy.position.y = h + 10.2;
      _dummy.updateMatrix();
      arms.push(s, _dummy.matrix);
    }
    poles.build(this.group);
    arms.build(this.group);
  }

  // ---------------------------------------------------------------------------
  // Cloverdale
  // ---------------------------------------------------------------------------

  /**
   * The built-up section: kerbs, footways, houses, driveways and street
   * lighting.
   *
   * This is scenery, but it is the scenery that tells the driver what kind of
   * road he is on. A five-lane arterial with nothing beside it reads as a wide
   * empty highway; the same road with houses set back thirty feet, a mailbox at
   * the end of every drive and a light on every other pole reads as somewhere
   * people live, which is the reason the move is being escorted through it at
   * thirty-five miles an hour with a unit on every light.
   */
  buildTown() {
    const route = this.route;
    const spans = [];
    // Find the stretches that are actually built up.
    let start = null;
    for (let s = 0; s <= route.length; s += 20) {
      const suburban = route.kindAt(s) === 'suburban';
      if (suburban && start === null) start = s;
      if (!suburban && start !== null) { spans.push([start, s]); start = null; }
    }
    if (start !== null) spans.push([start, route.length]);
    this.townSpans = spans;
    if (!spans.length) return;

    // Both ribbons are drawn double-sided: which way round a strip is wound
    // depends on which side of the road it is on, and a kerb that vanishes when
    // you drive past it on the wrong side is worse than one triangle's savings.
    const concrete = new MeshStandardMaterial({ color: 0xa9a69e, roughness: 0.95, side: DoubleSide });
    const kerbMat = new MeshStandardMaterial({ color: 0xbdbab2, roughness: 0.9, side: DoubleSide });

    // --- Kerb and footway ---------------------------------------------------
    const walk = { positions: [], indices: [] };
    const kerb = { positions: [], indices: [] };
    for (const [a, b] of spans) {
      for (const side of [-1, 1]) {
        this.addRibbon(kerb, {
          from: a, to: b, height: 0.14,
          innerAt: (s) => side * route.halfWidthAt(s),
          outerAt: (s) => side * (route.halfWidthAt(s) + 0.25),
        });
        this.addRibbon(walk, {
          from: a, to: b, height: 0.15,
          innerAt: (s) => side * (route.halfWidthAt(s) + 0.9),
          outerAt: (s) => side * (route.halfWidthAt(s) + 2.5),
        });
      }
    }
    this.group.add(this.ribbonMesh(kerb, kerbMat), this.ribbonMesh(walk, concrete));

    // --- Houses -------------------------------------------------------------
    const wallGeo = new BoxGeometry(11, 3.4, 8.5);
    const roofGeo = new ConeGeometry(8.4, 2.6, 4);
    // Laid flat at build time so an instance's local +Z is its length. That
    // lets each drive be aimed at its own house with `lookAt`, which picks up
    // the fall of the ground between the kerb and the door -- a driveway placed
    // flat at one height buries its own bottom end in the verge.
    const driveGeo = new PlaneGeometry(4.2, 1).rotateX(-Math.PI / 2);
    const wallMat = new MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    const roofMat = new MeshStandardMaterial({ color: 0x4a4744, roughness: 0.95 });
    const driveMat = new MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.95 });
    const boxGeo = new BoxGeometry(0.28, 0.22, 0.42);
    const postGeo = new CylinderGeometry(0.05, 0.05, 1.1, 5);
    const boxMat = new MeshStandardMaterial({ color: 0x39424c, roughness: 0.7, metalness: 0.3 });
    const woodMat = new MeshStandardMaterial({ color: 0x6b5844, roughness: 0.95 });

    const lots = [];
    for (const [a, b] of spans) {
      for (let s = a + 20; s < b - 20; s += 26 + Math.random() * 10) {
        for (const side of [-1, 1]) {
          if (this.nearJunction(s, side, 30)) continue;
          if (Math.random() < 0.12) continue;   // a gap, a park, a lot for sale
          lots.push({ s, side, setback: 14 + Math.random() * 7, yaw: (Math.random() - 0.5) * 0.12 });
        }
      }
    }

    const walls = new InstanceSet(wallGeo, wallMat, { castShadow: true, receiveShadow: true });
    const roofs = new InstanceSet(roofGeo, roofMat, { castShadow: true });
    const drives = new InstanceSet(driveGeo, driveMat);
    const boxes = new InstanceSet(boxGeo, boxMat);
    const posts = new InstanceSet(postGeo, woodMat);

    const paint = new Color();
    const palette = [0xd6d2c6, 0xc9d3d6, 0xd8c9b6, 0xbfc9b6, 0xd6c2c2, 0xcfcfd6];

    lots.forEach((lot, i) => {
      const kerb = route.halfWidthAt(lot.s) + 2.8;
      const lateral = lot.side * (kerb + lot.setback);
      route.positionAt(lot.s, lateral, _p);
      const h = this.ground.heightAt(_p.x, _p.z);
      // Turned so the long wall faces the road, which is what makes a row of
      // them read as a street rather than as a field of sheds.
      const heading = route.headingAt(lot.s) + lot.yaw + Math.PI / 2;

      _dummy.position.set(_p.x, h + 1.7, _p.z);
      _dummy.rotation.set(0, heading, 0);
      _dummy.scale.set(0.8 + Math.random() * 0.35, 1, 0.85 + Math.random() * 0.3);
      _dummy.updateMatrix();
      paint.setHex(palette[i % palette.length]);
      walls.push(lot.s, _dummy.matrix, paint);

      _dummy.position.y = h + 4.5;
      _dummy.rotation.set(0, heading + Math.PI / 4, 0);
      _dummy.scale.set(0.95, 1, 0.95);
      _dummy.updateMatrix();
      roofs.push(lot.s, _dummy.matrix);

      // Driveway, running straight out from the kerb to the front of the house.
      // Both ends are taken at the same station so it leaves the road square
      // rather than skewing across the lawn.
      const driveS = lot.s + 6;
      const nearLateral = lot.side * (route.halfWidthAt(driveS) - 0.5);
      const farLateral = lot.side * (kerb + lot.setback - 3);
      route.positionAt(driveS, nearLateral, _q);
      const nearY = this.ground.heightAt(_q.x, _q.z);
      const nearX = _q.x;
      const nearZ = _q.z;
      route.positionAt(driveS, farLateral, _q);
      const farY = this.ground.heightAt(_q.x, _q.z);

      _dummy.position.set((nearX + _q.x) / 2, (nearY + farY) / 2 + 0.05, (nearZ + _q.z) / 2);
      _dummy.scale.set(1, 1, Math.hypot(_q.x - nearX, farY - nearY, _q.z - nearZ));
      _dummy.up.set(0, 1, 0);
      _dummy.lookAt(_q.x, farY + 0.05, _q.z);
      _dummy.updateMatrix();
      drives.push(lot.s, _dummy.matrix);

      // Mailbox at the end of it.
      route.positionAt(driveS, lot.side * (route.halfWidthAt(lot.s) + 3.2), _q);
      const mh = this.ground.heightAt(_q.x, _q.z);
      _dummy.rotation.set(0, heading, 0);
      _dummy.scale.setScalar(1);
      _dummy.position.set(_q.x, mh + 1.18, _q.z);
      _dummy.updateMatrix();
      boxes.push(lot.s, _dummy.matrix);
      _dummy.position.y = mh + 0.55;
      _dummy.updateMatrix();
      posts.push(lot.s, _dummy.matrix);
    });

    for (const set of [walls, roofs, drives, boxes, posts]) set.build(this.group);

    // --- Street lighting ----------------------------------------------------
    const lightPoleGeo = new CylinderGeometry(0.11, 0.15, 8.4, 8);
    const armGeo = new BoxGeometry(0.10, 0.10, 2.0);
    const headGeo = new BoxGeometry(0.42, 0.16, 0.9);
    const steel = new MeshStandardMaterial({ color: 0x8e9299, metalness: 0.7, roughness: 0.5 });
    const lens = new MeshStandardMaterial({
      color: 0xd8d4c4, emissive: 0x2a2418, roughness: 0.5,
    });

    const stations = [];
    for (const [a, b] of spans) {
      for (let s = a + 30, n = 0; s < b - 10; s += 55, n++) {
        stations.push({ s, side: n % 2 === 0 ? 1 : -1 });
      }
    }
    const lightPoles = new InstanceSet(lightPoleGeo, steel, { castShadow: true });
    const lightArms = new InstanceSet(armGeo, steel);
    const lightHeads = new InstanceSet(headGeo, lens);

    stations.forEach((st) => {
      const lateral = st.side * (route.halfWidthAt(st.s) + 1.0);
      route.positionAt(st.s, lateral, _p);
      const h = this.ground.heightAt(_p.x, _p.z);
      const heading = route.headingAt(st.s);
      _dummy.rotation.set(0, heading, 0);
      _dummy.scale.setScalar(1);
      _dummy.position.set(_p.x, h + 4.2, _p.z);
      _dummy.updateMatrix();
      lightPoles.push(st.s, _dummy.matrix);

      // The arm reaches out over the kerb lane, which is where the light is
      // wanted and why every one of these leans over the road.
      route.positionAt(st.s, lateral - st.side * 1.1, _q);
      _dummy.position.set(_q.x, h + 8.3, _q.z);
      _dummy.rotation.set(0, heading + Math.PI / 2, 0);
      _dummy.updateMatrix();
      lightArms.push(st.s, _dummy.matrix);

      route.positionAt(st.s, lateral - st.side * 2.1, _q);
      _dummy.position.set(_q.x, h + 8.25, _q.z);
      _dummy.rotation.set(0, heading, 0);
      _dummy.updateMatrix();
      lightHeads.push(st.s, _dummy.matrix);
    });
    for (const set of [lightPoles, lightArms, lightHeads]) set.build(this.group);
  }

  /**
   * A flat ribbon following the route between two lateral offsets, used for
   * footways and kerbs.
   */
  addRibbon(target, { from, to, innerAt, outerAt, height, step = 4 }) {
    const route = this.route;
    let prevBase = -1;
    for (let s = from; s <= to; s += step) {
      const sample = route.at(s);
      const base = target.positions.length / 3;
      for (const offset of [innerAt(s), outerAt(s)]) {
        _p.copy(sample.position).addScaledVector(sample.lateral, offset);
        const ground = this.ground.heightAt(_p.x, _p.z);
        target.positions.push(_p.x, Math.max(ground, sample.position.y) + height, _p.z);
      }
      if (prevBase >= 0) {
        target.indices.push(prevBase, prevBase + 1, base, prevBase + 1, base + 1, base);
      }
      prevBase = base;
    }
  }

  ribbonMesh(set, material) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(set.positions), 3));
    geo.setIndex(set.indices);
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, material);
    mesh.receiveShadow = true;
    return mesh;
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
      const weld = new Weld();
      const sample = route.at(b.s);
      const halfWidth = route.halfWidthAt(b.s);
      const width = halfWidth * 2 + 14;

      // Deck: its underside sits at the posted clearance.
      const deckThickness = 1.3;
      weld.add(new BoxGeometry(width, deckThickness, b.span), concrete,
        { y: b.clearance + deckThickness / 2 });

      // Girders under the deck, kept above the clearance line.
      const girderGeo = new BoxGeometry(width * 0.98, 0.22, 0.9);
      for (let i = -2; i <= 2; i++) {
        weld.add(girderGeo, girder, { y: b.clearance + 0.12, z: i * (b.span / 5.5) });
      }
      girderGeo.dispose();

      // Abutments outside the road width, and the parapet.
      const pierGeo = new BoxGeometry(4.5, b.clearance + 2, b.span + 1.5);
      const railGeo = new BoxGeometry(width, 1.0, 0.3);
      for (const side of [-1, 1]) {
        weld.add(pierGeo, concrete,
          { x: side * (halfWidth + 3.4), y: (b.clearance + 2) / 2 - 1 });
        weld.add(railGeo, concrete,
          { y: b.clearance + deckThickness + 0.5, z: side * (b.span / 2) });
      }
      pierGeo.dispose();
      railGeo.dispose();
      weld.build(g);

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
    route.positionAt(s, route.halfWidthAt(s) + 2.2, _p);
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

  /**
   * The side roads.
   *
   * A junction is either a road ending on this one -- a farm lane, a quarry
   * road, something with a stop sign on it -- or a full crossroads with a light
   * and a road going out the other side. The escorts treat the two completely
   * differently, so they are built differently too.
   */
  buildJunctions() {
    const route = this.route;
    const paint = this.paint.white;

    for (const j of route.junctions) {
      const sample = route.at(j.s);
      const halfWidth = route.halfWidthAt(j.s);
      const roadWidth = j.signal ? 11.0 : 7.4;
      // Long enough to read as a road going somewhere, short enough that in town
      // it stays on the graded ground rather than running off the edge of it.
      const length = route.kindAt(j.s) === 'suburban' ? 62 : 90;

      const sides = j.crossing ? [1, -1] : [j.side];
      for (const side of sides) {
        _p.copy(sample.lateral).multiplyScalar(side).normalize();
        const dir = _p.clone();

        const road = new Mesh(
          new PlaneGeometry(roadWidth, length),
          this.sideRoadMaterial(roadWidth, length)
        );
        road.rotation.x = -Math.PI / 2;
        road.receiveShadow = true;
        road.position.copy(sample.position).addScaledVector(dir, halfWidth + length / 2 - 1);
        road.position.y = sample.position.y + 0.02;
        road.rotation.z = Math.atan2(dir.x, dir.z);
        this.group.add(road);

        // Stop line across the mouth of it. On a two-way cross street the line
        // only covers the approaching half.
        _q2.copy(sample.position)
          .addScaledVector(dir, halfWidth + 2.6)
          .addScaledVector(sample.tangent, side * roadWidth * 0.25);
        this.addPatch(paint, j.s, _q2, dir, sample.tangent,
          0.25, roadWidth * 0.25, sample.position.y + 0.03);

        this.group.add(this.makeStreetSign(j, sample, dir));
      }

      if (j.signal) {
        // Crosswalks and a stop bar on the highway itself: the marks that make an
        // intersection read as one from the cab.
        for (const end of [-1, 1]) {
          const at = j.s + end * (roadWidth * 0.5 + 2.4);
          for (let k = 0; k < 8; k++) {
            const lateral = -halfWidth + 1.2 + k * ((halfWidth * 2 - 2.4) / 7);
            this.addMark(paint, at, lateral, 2.0, 0.45);
          }
        }
        for (const end of [-1, 1]) {
          const at = j.s + end * (roadWidth * 0.5 + 5.2);
          const inner = 0.2;
          const outer = route.edgeOffsetAt(at);
          const mid = end > 0 ? -(inner + outer) / 2 : (inner + outer) / 2;
          this.addMark(paint, at, mid, 0.6, outer - inner);
        }
      }
    }
  }

  /**
   * Paving for a side road of a given size.
   *
   * Same asphalt as the highway, tiled to the same density in metres so a road
   * eleven metres wide does not end up with a different grain from the one it
   * joins. Pushed forward in depth rather than lifted: two centimetres of height
   * does not win a depth test a hundred metres away, and any more than that is a
   * lip the wheels would find.
   */
  sideRoadMaterial(width, length) {
    this._sideRoadMats ??= new Map();
    const key = `${width}x${length}`;
    let mat = this._sideRoadMats.get(key);
    if (!mat) {
      const tex = makeAsphaltTexture();
      tex.repeat.set(width / 8, length / 8);
      mat = new MeshStandardMaterial({ map: tex, roughness: 0.94, metalness: 0.02 });
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -3;
      mat.polygonOffsetUnits = -4;
      this._sideRoadMats.set(key, mat);
    }
    return mat;
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
      .addScaledVector(dir, this.route.halfWidthAt(junction.s) + 2.5);
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

  // ---------------------------------------------------------------------------
  // Signals
  // ---------------------------------------------------------------------------

  /**
   * Signal heads on mast arms.
   *
   * Two arms reach out over the highway, one for each approach, and a pedestal
   * head faces each arm of the cross street. Every lens is its own material, so
   * a controller state is one colour assignment per lamp and the whole
   * intersection updates in a few dozen writes a frame.
   */
  buildSignals() {
    this.signalHeads = new Map();
    const route = this.route;
    const network = route.signals;
    if (!network) return;

    const steel = new MeshStandardMaterial({ color: 0x59606a, metalness: 0.65, roughness: 0.5 });
    const housing = new MeshStandardMaterial({ color: 0x1e2328, metalness: 0.3, roughness: 0.7 });

    const bodyGeo = new BoxGeometry(0.42, 1.15, 0.30);
    const visorGeo = new BoxGeometry(0.46, 1.2, 0.06);
    const lensGeo = new CylinderGeometry(0.13, 0.13, 0.06, 8);
    const mastGeo = new CylinderGeometry(0.16, 0.20, 8.2, 6);
    const postGeo = new CylinderGeometry(0.10, 0.13, 5.0, 6);

    for (const signal of network.signals) {
      const j = signal.junction;
      const sample = route.at(j.s);
      const halfWidth = route.halfWidthAt(j.s);
      const heading = Math.atan2(sample.tangent.x, sample.tangent.z);
      const group = new Group();
      group.position.copy(sample.position);
      group.rotation.y = heading;

      // All the steelwork at one intersection -- two masts, two arms, two
      // pedestals and six housings -- is one mesh. None of it moves, and thirty
      // separate objects per intersection was four hundred draw calls across the
      // route for ten thousand triangles.
      const hardware = new Weld();
      const mainline = [];
      const cross = [];

      // Lenses are welded per colour across all the heads showing the same
      // phase, because that is how they are driven: every mainline head is red
      // together or green together, and so is every head on the cross street.
      // Eighteen lens meshes an intersection became six.
      const lensWelds = { mainline: new Weld(), cross: new Weld() };
      const lensMats = { mainline: {}, cross: {} };
      for (const face of ['mainline', 'cross']) {
        for (const name of ['red', 'amber', 'green']) {
          lensMats[face][name] = new MeshBasicMaterial({ color: SIGNAL_DARK[name].clone() });
        }
      }

      /** Files a head's housing and lenses into the welds for its face. */
      const head = (face, x, y, z, ry) => {
        hardware.add(bodyGeo, housing, { x, y, z, ry });
        hardware.add(visorGeo, housing, { x, y, z: z - 0.02 * Math.cos(ry), ry });
        for (const [name, dy] of [['red', 0.36], ['amber', 0], ['green', -0.36]]) {
          lensWelds[face].add(lensGeo, lensMats[face][name], {
            x: x + Math.sin(ry) * 0.17, y: y + dy, z: z + Math.cos(ry) * 0.17,
            rx: Math.PI / 2,
          });
        }
      };

      // Mast arms for the two highway approaches. Each stands on the corner the
      // approaching driver passes on his right and reaches out over the lanes.
      for (const approach of [1, -1]) {
        const poleX = approach * (halfWidth + 0.9);
        const poleZ = -approach * (halfWidth * 0.55 + 6);
        hardware.add(mastGeo, steel, { x: poleX, y: 4.1, z: poleZ });

        const reach = halfWidth * 0.95;
        const armGeo = new BoxGeometry(reach, 0.16, 0.16);
        hardware.add(armGeo, steel, { x: poleX - approach * reach * 0.5, y: 7.2, z: poleZ });
        armGeo.dispose();

        // Heads hang over the two lanes the approach uses, at the six metres or
        // so of clearance a mast arm actually gives -- which is well above a
        // 13'-7" load, but not by as much as it looks from the ground.
        for (const k of [0.42, 0.78]) {
          head('mainline', poleX - approach * reach * k, 6.4, poleZ,
            approach > 0 ? Math.PI : 0);
        }
      }

      // Pedestal heads facing the cross street, on both arms of it.
      for (const side of [1, -1]) {
        hardware.add(postGeo, steel, { x: side * (halfWidth + 1.4), y: 2.5, z: side * 2.2 });
        head('cross', side * (halfWidth + 1.4), 5.5, side * 2.2,
          side > 0 ? -Math.PI / 2 : Math.PI / 2);
      }

      hardware.build(group, { receiveShadow: false });
      lensWelds.mainline.build(group, { castShadow: false, receiveShadow: false });
      lensWelds.cross.build(group, { castShadow: false, receiveShadow: false });
      this.group.add(group);
      this.signalHeads.set(signal, { mainline: lensMats.mainline, cross: lensMats.cross });
    }

    for (const geo of [bodyGeo, visorGeo, mastGeo, postGeo]) geo.dispose();
  }

  /** Pushes the controller states onto the lenses. */
  updateSignals(network) {
    if (!this.signalHeads) return;
    for (const signal of network.signals) {
      const heads = this.signalHeads.get(signal);
      if (!heads) continue;
      this.setHeads(heads.mainline, signal.mainline);
      this.setHeads(heads.cross, signal.cross);
    }
  }

  /** One colour assignment per lamp material -- six writes per intersection. */
  setHeads(lamps, phase) {
    for (const name of ['red', 'amber', 'green']) {
      const lit = name === phase || (name === 'amber' && phase === 'yellow');
      lamps[name].color.copy(lit ? SIGNAL_LIT[name] : SIGNAL_DARK[name]);
    }
  }

  // ---------------------------------------------------------------------------
  // Signing
  // ---------------------------------------------------------------------------

  /** Speed limit signs wherever the posted limit changes. */
  buildSigns() {
    const route = this.route;
    for (const change of route.corridor.limitChanges()) {
      if (change.s < 10) continue;
      this.group.add(this.makeSpeedSign(change.s + 25, change.limitMph));
    }
  }

  makeSpeedSign(s, limitMph) {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 250;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f4f0';
    ctx.fillRect(0, 0, 200, 250);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 7;
    ctx.strokeRect(9, 9, 182, 232);
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.font = 'bold 32px Arial';
    ctx.fillText('SPEED', 100, 62);
    ctx.fillText('LIMIT', 100, 98);
    ctx.font = 'bold 104px Arial';
    ctx.fillText(String(limitMph), 100, 200);

    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const sign = new Mesh(
      new PlaneGeometry(1.5, 1.9),
      new MeshBasicMaterial({ map: tex, side: DoubleSide })
    );
    this.route.positionAt(s, this.route.halfWidthAt(s) + 1.6, _p);
    const ground = this.ground.heightAt(_p.x, _p.z);
    sign.position.set(_p.x, ground + 2.5, _p.z);
    sign.rotation.y = this.route.headingAt(s) + Math.PI;

    const post = new Mesh(
      new CylinderGeometry(0.06, 0.06, 2.6, 6),
      new MeshStandardMaterial({ color: 0x777c82, metalness: 0.7, roughness: 0.5 })
    );
    post.position.set(_p.x, ground + 1.3, _p.z);

    const g = new Group();
    g.add(sign, post);
    return g;
  }
}
