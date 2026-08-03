import {
  Group, Mesh, MeshStandardMaterial, MeshBasicMaterial, BufferGeometry,
  BufferAttribute, Vector3, CanvasTexture, RepeatWrapping, DoubleSide,
  BoxGeometry, CylinderGeometry, ConeGeometry, PlaneGeometry, InstancedMesh,
  Object3D, Color, SRGBColorSpace,
} from 'three';
import { Weld } from './Models.js';
import { Corridor } from '../world/Corridor.js';
import { BUILT_UP_SHELF } from '../world/Ground.js';

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
 * A building's front, drawn once for each size in the catalogue.
 *
 * Windows are what make a box a building, and at the distance these are seen
 * from that is all they need to be: a grid at storey spacing, unevenly lit,
 * against the wall colour. Drawing it at the building's real size rather than
 * scaling one texture is the whole point -- a tower and a warehouse have windows
 * the same size as each other in life, and stretching one image over both is
 * exactly what makes rendered cities look like toys.
 */
function makeFacadeTexture(widthM, heightM, style) {
  const storey = style === 'shed' ? 4.5 : 3.4;
  const bay = style === 'shed' ? 6.0 : 3.0;
  const rows = Math.max(1, Math.round(heightM / storey));
  const cols = Math.max(2, Math.round(widthM / bay));

  const canvas = document.createElement('canvas');
  canvas.width = Math.min(512, cols * 16);
  canvas.height = Math.min(512, rows * 16);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cw = canvas.width / cols;
  const chh = canvas.height / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // The ground floor is a shopfront or a loading door rather than a window.
      const ground = r === rows - 1;
      const lit = Math.random();
      if (style === 'shed' && !ground) continue;
      ctx.fillStyle = ground
        ? (style === 'shed' ? '#2f3336' : '#3b4148')
        : lit > 0.82 ? '#c8c2a2' : lit > 0.4 ? '#39434e' : '#2b333c';
      const inset = ground ? 0.10 : 0.18;
      ctx.fillRect(
        (c + inset) * cw, (r + (ground ? 0.15 : 0.22)) * chh,
        cw * (1 - inset * 2), chh * (ground ? 0.7 : 0.56)
      );
    }
  }

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
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
 * How far out each kind of detail is worth drawing, in metres.
 *
 * A tree two kilometres down the road is inside the frustum, is a couple of
 * pixels tall, and is most of the way to the fog colour already -- so the
 * frustum test alone keeps far too much alive once the draw distance is long
 * enough to show the country the route runs through. Anything with a range
 * switches off past it; the coarse terrain that makes the horizon does not have
 * one, because it is what is left to look at.
 */
const TREE_RANGE = 1700;

/**
 * How far back from the kerb the ground is city rather than country, by road
 * kind. Matches the graded shelf in `Ground`, since it is the same shelf.
 */
const BUILT_SHELF = { downtown: 120, urban: 64, industrial: 70 };
const DETAIL_RANGE = 950;

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
  build(parent, ranged = null, range = 0) {
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
      if (ranged) ranged.push({ mesh, sphere: mesh.boundingSphere, range });
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

  build(parent, ranged = null, range = 0) {
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
      geo.computeBoundingSphere();
      const mesh = new Mesh(geo, mat);
      parent.add(mesh);
      if (ranged) ranged.push({ mesh, sphere: geo.boundingSphere, range });
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

    // Chunks that are cheap to draw but pointless at a distance -- trees,
    // houses, street furniture, lane paint -- carry their own range and are
    // switched off beyond it. The frustum test alone cannot do this: a tree two
    // kilometres down the road is in front of the camera, it is just not worth
    // anything once the haze has taken it.
    this.ranged = [];

    this.buildRoad();
    this.buildMarkings();
    this.buildDistantTerrain();
    this.buildTerrain();
    this.buildScenery();
    this.buildCity();
    this.buildMedianBarrier();
    this.buildBridges();
    this.buildJunctions();
    this.buildPaint();
    this.buildSignals();
    this.buildSigns();
  }

  /** Stretches of route whose road kind satisfies a predicate. */
  spansWhere(predicate, step = 20) {
    const spans = [];
    let start = null;
    for (let s = 0; s <= this.route.length; s += step) {
      const on = predicate(this.route.kindAt(s), s);
      if (on && start === null) start = s;
      if (!on && start !== null) { spans.push([start, s]); start = null; }
    }
    if (start !== null) spans.push([start, this.route.length]);
    return spans;
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

    // The centre of the road, which is three different things on this route. A
    // street with no turn lane gets the familiar double yellow; one with a turn
    // lane gets that lane's markings, solid on the outside and dashed on the
    // inside; and a freeway gets none of it, because what is down the middle
    // there is a concrete barrier and a white edge line on each side of it.
    const centre = (s) => route.corridor.centre(s);
    const plain = (s) => centre(s) === 'double-yellow';
    const divided = (s) => centre(s) === 'barrier';
    for (const side of [-1, 1]) {
      this.addStripe(yellow, {
        offsetAt: (s) => (plain(s) ? side * 0.17 : side * route.medianAt(s) * 0.5),
        width: 0.13,
        existsAt: (s) => !divided(s),
      });
      this.addStripe(yellow, {
        offsetAt: (s) => side * (route.medianAt(s) * 0.5 - 0.42),
        width: 0.13,
        existsAt: (s) => !plain(s) && !divided(s),
        dash: [3, 3],
      });
      // The freeway's inside edge line, against the barrier.
      this.addStripe(white, {
        offsetAt: (s) => side * (route.medianAt(s) * 0.5 + 0.35),
        width: 0.13,
        existsAt: divided,
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
    // Lane paint is a few centimetres wide. Past a kilometre it is under a pixel
    // and well inside the haze, so it stops being drawn.
    this.paint.white.build(this.markings, this.ranged, 1100);
    this.paint.yellow.build(this.markings, this.ranged, 1100);
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
   * The country the route runs through, out to the horizon.
   *
   * Without this the world simply stopped: the terrain was a band 260 m either
   * side of the road and beyond it was sky, so every view ended in a cliff edge
   * with nothing behind it. That is most of why the map read as empty -- there
   * was no landscape, only a strip of verge.
   *
   * It is a coarse grid over the whole area at two hundred metres a cell, which
   * is fine enough for the broad component of the terrain function -- the one
   * with a six-hundred-metre wavelength that makes the hills -- and cheap enough
   * that the whole horizon is a few thousand triangles. The detail near the road
   * is the fine band's job.
   *
   * Near the route the grid is pressed down, so it can never poke up through the
   * band that is drawn on top of it; and the band's outer edge is blended onto
   * this surface exactly, so the two meet without a seam.
   */
  buildDistantTerrain() {
    const route = this.route;
    const step = 200;
    const margin = 6400;

    let minX = Infinity; let maxX = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    for (const s of route.samples) {
      minX = Math.min(minX, s.position.x); maxX = Math.max(maxX, s.position.x);
      minZ = Math.min(minZ, s.position.z); maxZ = Math.max(maxZ, s.position.z);
    }
    const x0 = Math.floor((minX - margin) / step) * step;
    const z0 = Math.floor((minZ - margin) / step) * step;
    const nx = Math.ceil((maxX + margin - x0) / step) + 1;
    const nz = Math.ceil((maxZ + margin - z0) / step) + 1;

    const heights = new Float32Array(nx * nz);
    const proj = {};
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const x = x0 + i * step;
        const z = z0 + k * step;
        route.project(x, z, proj);
        // Pressed down where the fine band will cover it, easing back to the
        // true surface by the time the band's outer edge arrives.
        const t = Math.min(1, proj.distance / 240);
        const sink = 9 * (1 - t * t * (3 - 2 * t));
        heights[i * nz + k] = this.ground.terrainHeight(x, z) - 0.35 - sink;
      }
    }
    this.distant = { x0, z0, step, nx, nz, heights };

    // --- Meshes, in blocks so they cull ------------------------------------
    const block = 8;
    const grass = new Color(0x5f7a3e);
    const dry = new Color(0x8e8551);
    const rock = new Color(0x6f6a61);
    const tmp = new Color();
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0 });
    this.distantMeshes = [];

    for (let bi = 0; bi < nx - 1; bi += block) {
      for (let bk = 0; bk < nz - 1; bk += block) {
        const iTo = Math.min(nx - 1, bi + block);
        const kTo = Math.min(nz - 1, bk + block);
        const positions = [];
        const colors = [];
        const indices = [];
        const w = kTo - bk + 1;

        for (let i = bi; i <= iTo; i++) {
          for (let k = bk; k <= kTo; k++) {
            const x = x0 + i * step;
            const z = z0 + k * step;
            const h = heights[i * nz + k];
            positions.push(x, h, z);
            const east = heights[Math.min(nx - 1, i + 1) * nz + k];
            const slope = Math.min(1, Math.abs(east - h) / 40);
            const patch = this.ground.patchNoise(x, z);
            tmp.copy(grass).lerp(dry, Math.min(1, Math.max(0, (h - 40) / 120)));
            tmp.lerp(dry, Math.max(0, (patch - 0.45) * 1.5));
            tmp.lerp(rock, slope * 0.8);
            tmp.multiplyScalar(0.86 + patch * 0.28);
            colors.push(tmp.r, tmp.g, tmp.b);
          }
        }
        for (let i = 0; i < iTo - bi; i++) {
          for (let k = 0; k < kTo - bk; k++) {
            const a = i * w + k;
            indices.push(a, a + 1, a + w, a + 1, a + w + 1, a + w);
          }
        }

        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
        geo.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        const mesh = new Mesh(geo, mat);
        this.group.add(mesh);
        this.distantMeshes.push(mesh);
      }
    }
  }

  /** The distant surface at a point, interpolated across its grid. */
  distantHeightAt(x, z) {
    const d = this.distant;
    const fi = Math.max(0, Math.min(d.nx - 1, (x - d.x0) / d.step));
    const fk = Math.max(0, Math.min(d.nz - 1, (z - d.z0) / d.step));
    const i0 = Math.min(d.nx - 2, Math.floor(fi));
    const k0 = Math.min(d.nz - 2, Math.floor(fk));
    const tx = fi - i0;
    const tz = fk - k0;
    const h = d.heights;
    const h00 = h[i0 * d.nz + k0];
    const h10 = h[(i0 + 1) * d.nz + k0];
    const h01 = h[i0 * d.nz + k0 + 1];
    const h11 = h[(i0 + 1) * d.nz + k0 + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
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
    const lanes = 16;
    // Wide enough to carry the cut and fill. A road crossing a valley fifty
    // metres deep is on an embankment hundreds of metres across, and the band
    // has to reach far enough out to show it landing.
    const maxLateral = 420;
    const perChunk = Math.max(2, Math.round(CHUNK / along));
    const count = Math.floor(route.length / along);

    const grass = new Color(0x6f8a45);
    const dry = new Color(0x9d9256);
    const rock = new Color(0x7a7369);
    const paving = new Color(0x6e6f6c);
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
        along, lanes, maxLateral, grass, dry, rock, paving, tmp, mat,
      });
      this.terrain.push(mesh);
      this.group.add(mesh);
    }
  }

  /** One chunk of the terrain skirt, from station `from` to station `to`. */
  terrainChunk(from, to, { along, lanes, maxLateral, grass, dry, rock, paving, tmp, mat }) {
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
        let h = this.ground.heightAt(_p.x, _p.z);
        // The last fifth of the band is faded onto the distant grid, reaching it
        // exactly at the outer edge. Both surfaces come from the same height
        // function but at very different resolutions, so butting them together
        // would leave the coarse one cutting through the fine one; blending
        // means the join is continuous wherever it falls.
        if (t > 0.8) {
          const blend = (t - 0.8) / 0.2;
          h += (this.distantHeightAt(_p.x, _p.z) - h) * blend * blend * (3 - 2 * blend);
        }
        positions.push(_p.x, h, _p.z);
        normals.push(0, 1, 0);

        // Tint by slope, elevation and ground cover, so the hill reads
        // differently from the flats and the flats are not one shade of green.
        const slope = Math.min(1, Math.abs(this.ground.heightAt(_p.x + 6, _p.z) - h) / 6);
        const patch = this.ground.patchNoise(_p.x, _p.z);
        tmp.copy(grass).lerp(dry, Math.min(1, Math.max(0, (h - 40) / 120)));
        tmp.lerp(dry, Math.max(0, (patch - 0.45) * 1.5));
        tmp.lerp(rock, slope * 0.75);
        tmp.multiplyScalar(0.86 + patch * 0.28);
        // Inside the city the ground between the buildings is not ground: it is
        // yards, car parks, side streets and the back of the block. Grass there
        // is what makes a rendered city read as a model village with roads laid
        // over a lawn, so the built-up shelf is faded toward paving instead.
        const built = BUILT_UP_SHELF[route.kindAt(s)] ?? 0;
        if (built && offset < built) {
          const fade = 1 - Math.pow(offset / built, 2);
          tmp.lerp(paving, 0.8 * fade * (0.75 + patch * 0.4));
        }
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
      const kind = route.kindAt(s);
      // A city gets street trees rather than woods: in the footway, and only
      // every so often, so the buildings behind them can still be seen. Nothing
      // is planted downtown, and nothing but scrub grows along a freeway.
      if (kind === 'downtown') continue;
      const street = kind === 'urban';
      if (street && Math.random() > 0.3) continue;
      const lateral = street
        ? side * (route.halfWidthAt(s) + 1.8 + Math.random() * 0.8)
        : side * (route.halfWidthAt(s) + 12 + Math.pow(Math.random(), 0.7) * 150);
      route.positionAt(s, lateral, _p);
      const h = this.ground.heightAt(_p.x, _p.z);

      // Keep the corridor and the junction mouths clear.
      if (this.nearJunction(s, side, 40) && Math.abs(lateral) < 60) continue;

      const scale = street ? 0.5 + Math.random() * 0.3 : 0.7 + Math.random() * 0.9;
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
    trunks.build(this.group, this.ranged, TREE_RANGE);
    crowns.build(this.group, this.ranged, TREE_RANGE);

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
    rails.build(this.group, this.ranged, DETAIL_RANGE);
    posts.build(this.group, this.ranged, DETAIL_RANGE);

    // --- Power lines, which the route is delivering a transformer to -------
    // Not downtown, where they are underground, and not along the interstate,
    // which does not have a pole line beside it.
    const poleMat = new MeshStandardMaterial({ color: 0x6b5844, roughness: 0.95 });
    const poleGeo = new CylinderGeometry(0.16, 0.22, 11, 6);
    const armGeo = new BoxGeometry(2.6, 0.14, 0.14);
    const poleCount = Math.floor(route.length / 90);
    const poles = new InstanceSet(poleGeo, poleMat, { castShadow: true });
    const arms = new InstanceSet(armGeo, poleMat);
    for (let i = 0; i < poleCount; i++) {
      const s = i * 90 + 40;
      const kind = route.kindAt(s);
      if (kind === 'downtown' || kind === 'freeway' || kind === 'ramp') continue;
      // Behind the footway rather than standing in it.
      const back = Corridor.isBuiltUp(kind) ? this.footwayWidth(s) - 1.2 : 6;
      route.positionAt(s, -(route.halfWidthAt(s) + back), _p);
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
    poles.build(this.group, this.ranged, TREE_RANGE);
    arms.build(this.group, this.ranged, DETAIL_RANGE);
  }

  // ---------------------------------------------------------------------------
  // The city
  // ---------------------------------------------------------------------------

  buildCity() {
    const route = this.route;
    // Everywhere the road runs between buildings rather than past them.
    const spans = this.spansWhere((kind) => Corridor.isBuiltUp(kind));
    this.citySpans = spans;
    if (!spans.length) return;

    // Both ribbons are drawn double-sided: which way round a strip is wound
    // depends on which side of the road it is on, and a kerb that vanishes when
    // you drive past it on the wrong side is worse than one triangle's savings.
    const concrete = new MeshStandardMaterial({ color: 0xa9a69e, roughness: 0.95, side: DoubleSide });
    const kerbMat = new MeshStandardMaterial({ color: 0xbdbab2, roughness: 0.9, side: DoubleSide });

    // --- Kerb and footway ---------------------------------------------------
    // A city footway is wide and it starts at the kerb, which is why there is no
    // shoulder to put a broken-down car on and why the load's mirrors are the
    // thing to watch downtown.
    const walk = { positions: [], indices: [] };
    const kerb = { positions: [], indices: [] };
    for (const [a, b] of spans) {
      for (const side of [-1, 1]) {
        this.addRibbon(kerb, {
          from: a, to: b, height: 0.16,
          innerAt: (s) => side * route.halfWidthAt(s),
          outerAt: (s) => side * (route.halfWidthAt(s) + 0.3),
        });
        this.addRibbon(walk, {
          from: a, to: b, height: 0.17,
          innerAt: (s) => side * (route.halfWidthAt(s) + 0.3),
          outerAt: (s) => side * (route.halfWidthAt(s) + this.footwayWidth(s)),
        });
      }
    }
    this.group.add(this.ribbonMesh(kerb, kerbMat), this.ribbonMesh(walk, concrete));

    this.buildBuildings(spans);
    this.buildStreetLighting(spans);
  }

  /**
   * How far the paving reaches back from the kerb before the buildings start.
   *
   * Generous downtown, narrower on the arterials, and in the industrial
   * districts it is a hardstanding rather than a footway. The buildings are set
   * to stand right at the back of it, because a city block with a lawn between
   * the pavement and the building line is a business park, not a city.
   */
  footwayWidth(s) {
    const kind = this.route.kindAt(s);
    if (kind === 'downtown') return 8.0;
    if (kind === 'urban') return 5.5;
    return 4.5;
  }

  /**
   * The buildings.
   *
   * This is scenery, but it is the scenery that tells the driver where he is. A
   * five-lane arterial with nothing beside it reads as an empty highway; the
   * same road with a wall of glass down both sides and the sky in a slot above
   * it reads as downtown, which is the reason the move is crawling through it at
   * twenty-five with a unit on every light.
   *
   * Three kinds go up, chosen by the road: towers downtown, three and four
   * storey blocks along the arterials, and long low sheds in the industrial
   * districts. Each is a handful of fixed sizes so that one instanced mesh per
   * size covers the whole city and the facade texture is never stretched to
   * something it was not drawn for.
   */
  buildBuildings(spans) {
    const route = this.route;

    // Fixed catalogue: [width, height, depth, style]. Nothing is scaled on the
    // instance, because a facade that is stretched by its instance matrix has
    // windows of a different size on every building.
    const catalogue = {
      downtown: [
        [22, 54, 20, 'tower'], [18, 38, 18, 'tower'], [26, 72, 22, 'tower'],
        [20, 26, 18, 'block'], [24, 44, 20, 'tower'],
      ],
      urban: [
        [18, 12, 14, 'block'], [22, 9, 16, 'block'], [15, 15, 13, 'block'],
        [26, 7, 18, 'shop'],
      ],
      industrial: [
        [34, 9, 26, 'shed'], [26, 7, 20, 'shed'], [44, 11, 30, 'shed'],
      ],
    };

    // One instanced set per catalogue entry, keyed so a lot can find the set for
    // whatever it decided to put up.
    const sets = new Map();
    for (const [kind, list] of Object.entries(catalogue)) {
      list.forEach((entry, i) => {
        const [w, h, , style] = entry;
        const geo = new BoxGeometry(w, h, entry[2]);
        const mat = new MeshStandardMaterial({
          map: makeFacadeTexture(w, h, style),
          roughness: style === 'tower' ? 0.4 : 0.85,
          metalness: style === 'tower' ? 0.25 : 0.05,
        });
        sets.set(`${kind}${i}`, new InstanceSet(geo, mat, { castShadow: true, receiveShadow: true }));
      });
    }

    // Every parapet in the city is one instanced unit cube scaled to its
    // building. A separate set per building size would be a dozen more draw
    // calls per chunk for a plain grey slab that nothing is textured on.
    const roofMat = new MeshStandardMaterial({ color: 0x4a4a48, roughness: 0.95 });
    const roofs = new InstanceSet(new BoxGeometry(1, 1, 1), roofMat, { castShadow: true });

    const tint = new Color();
    const palettes = {
      downtown: [0x9aa4b0, 0x8f9aa6, 0xa8a49c, 0x7f8b98, 0xb0aca4],
      urban: [0xc9beb0, 0xb9a898, 0xc4c0b6, 0xa89c92, 0xd0c6ba],
      industrial: [0x9fa5a8, 0xb0aca2, 0x8e9498],
    };

    let placed = 0;
    for (const [from, to] of spans) {
      const kind = route.kindAt((from + to) * 0.5);
      const list = catalogue[kind] ?? catalogue.urban;
      const palette = palettes[kind] ?? palettes.urban;
      const spacing = kind === 'downtown' ? 30 : kind === 'industrial' ? 52 : 32;

      // How far back the rows of buildings stand. Downtown gets a second and a
      // third row, which is what closes the view off at the end of a side street
      // instead of showing open country a block away.
      const rows = kind === 'downtown' ? [0, 46, 96] : kind === 'urban' ? [0, 44] : [0];

      for (let s = from + 24; s < to - 24; s += spacing * (0.8 + Math.random() * 0.5)) {
        for (const side of [-1, 1]) {
          for (const row of rows) {
            // Leave the junction mouths open, and let a lot go empty now and
            // then: a car park, a plaza, a site with a crane on it.
            if (row === 0 && this.nearJunction(s, side, 32)) continue;
            if (Math.random() < (row ? 0.3 : 0.12)) continue;

            const i = Math.floor(Math.random() * list.length);
            const [w, h, d] = list[i];
            // Downtown builds tall in the middle of the district and lower at
            // its edges, which is what makes a skyline rather than a wall.
            const centreness = 1 - Math.abs(((s - from) / (to - from)) * 2 - 1);
            if (kind === 'downtown' && h > 40 && centreness < 0.12 + Math.random() * 0.35) continue;

            const stand = route.halfWidthAt(s) + this.footwayWidth(s) + d * 0.5 + 0.4 + row;
            const lateral = side * stand;
            route.positionAt(s, lateral, _p);
            const ground = this.ground.heightAt(_p.x, _p.z);
            const heading = route.headingAt(s) + Math.PI / 2 + (Math.random() - 0.5) * 0.05;

            _dummy.position.set(_p.x, ground + h * 0.5, _p.z);
            _dummy.rotation.set(0, heading, 0);
            _dummy.scale.setScalar(1);
            _dummy.updateMatrix();
            tint.setHex(palette[placed % palette.length]);
            sets.get(`${kind}${i}`).push(s, _dummy.matrix, tint);

            _dummy.position.y = ground + h + 0.5;
            _dummy.scale.set(w + 0.5, 1.0, d + 0.5);
            _dummy.updateMatrix();
            roofs.push(s, _dummy.matrix);
            placed++;
          }
        }
      }
    }

    // Towers are worth seeing from a long way off -- they are most of what says
    // "city" from the freeway -- so they carry the tree range rather than the
    // street-furniture one.
    for (const set of sets.values()) set.build(this.group, this.ranged, TREE_RANGE);
    roofs.build(this.group, this.ranged, DETAIL_RANGE);
    this.buildingCount = placed;
  }

  /**
   * Street lighting.
   *
   * On alternate sides, reaching out over the kerb lane, which is where the
   * light is wanted and why every one of these leans over the road.
   */
  buildStreetLighting(spans) {
    const route = this.route;
    const lightPoleGeo = new CylinderGeometry(0.11, 0.15, 8.4, 8);
    const armGeo = new BoxGeometry(0.10, 0.10, 2.0);
    const headGeo = new BoxGeometry(0.42, 0.16, 0.9);
    const steel = new MeshStandardMaterial({ color: 0x8e9299, metalness: 0.7, roughness: 0.5 });
    const lens = new MeshStandardMaterial({
      color: 0xd8d4c4, emissive: 0x2a2418, roughness: 0.5,
    });

    const stations = [];
    for (const [a, b] of spans) {
      for (let s = a + 30, n = 0; s < b - 10; s += 48, n++) {
        stations.push({ s, side: n % 2 === 0 ? 1 : -1 });
      }
    }
    const lightPoles = new InstanceSet(lightPoleGeo, steel, { castShadow: true });
    const lightArms = new InstanceSet(armGeo, steel);
    const lightHeads = new InstanceSet(headGeo, lens);

    stations.forEach((st) => {
      const lateral = st.side * (route.halfWidthAt(st.s) + 1.2);
      route.positionAt(st.s, lateral, _p);
      const h = this.ground.heightAt(_p.x, _p.z);
      const heading = route.headingAt(st.s);
      _dummy.rotation.set(0, heading, 0);
      _dummy.scale.setScalar(1);
      _dummy.position.set(_p.x, h + 4.2, _p.z);
      _dummy.updateMatrix();
      lightPoles.push(st.s, _dummy.matrix);

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
    for (const set of [lightPoles, lightArms, lightHeads]) set.build(this.group, this.ranged, DETAIL_RANGE);
  }

  /**
   * The concrete barrier down the middle of the interstate.
   *
   * It is the reason the freeway reads as a freeway from the cab rather than as
   * a very wide street: there is no oncoming traffic to be seen, only a wall a
   * metre from the load's left-hand outriggers.
   */
  buildMedianBarrier() {
    const route = this.route;
    const spans = this.spansWhere((kind, s) => route.corridor.centre(s) === 'barrier');
    if (!spans.length) return;

    const mat = new MeshStandardMaterial({ color: 0xb4b1a8, roughness: 0.92 });
    const geo = new BoxGeometry(0.62, 0.92, 4.0);
    const barrier = new InstanceSet(geo, mat, { castShadow: true, receiveShadow: true });
    for (const [a, b] of spans) {
      for (let s = a; s < b; s += 4) {
        route.positionAt(s, 0, _p);
        _dummy.position.set(_p.x, _p.y + 0.46, _p.z);
        _dummy.rotation.set(0, route.headingAt(s), 0);
        _dummy.scale.setScalar(1);
        _dummy.updateMatrix();
        barrier.push(s, _dummy.matrix);
      }
    }
    barrier.build(this.group, this.ranged, DETAIL_RANGE);
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
      const roadWidth = j.signal ? 14.0 : 8.0;
      // Long enough to read as a street going somewhere. In the city it can run
      // right out to the buildings, because the ground under them was graded
      // flat when the place was built.
      const length = Corridor.isBuiltUp(route.kindAt(j.s)) ? 120 : 90;

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
    const geo = new PlaneGeometry(2.6, 0.49);
    const mat = new MeshBasicMaterial({ map: tex });

    const pos = sample.position.clone()
      .addScaledVector(dir, this.route.halfWidthAt(junction.s) + 2.5);
    const heading = Math.atan2(sample.tangent.x, sample.tangent.z);

    const g = new Group();
    // Two boards back to back rather than one drawn double-sided. A single plane
    // seen from behind shows the text mirrored, which at a four-way is half the
    // signs on the route -- and a street name you have to read in a mirror is
    // worse than no sign at all.
    for (const face of [0, Math.PI]) {
      const board = new Mesh(geo, mat);
      board.position.set(pos.x, pos.y + 3.0, pos.z);
      board.rotation.y = heading + face;
      g.add(board);
    }

    const post = new Mesh(
      new CylinderGeometry(0.06, 0.06, 3.0, 6),
      new MeshStandardMaterial({ color: 0x777c82, metalness: 0.7, roughness: 0.5 })
    );
    post.position.set(pos.x, pos.y + 1.5, pos.z);
    g.add(post);
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

  /**
   * Switches off the chunks of detail that are too far away to be worth drawing.
   *
   * Measured to the near edge of each chunk's bounding sphere rather than its
   * centre, so a chunk half of which is in range stays on and there is no edge
   * for a tree to pop across as you drive down it.
   */
  updateVisibility(cameraPosition) {
    for (const entry of this.ranged) {
      const c = entry.sphere.center;
      const dx = c.x - cameraPosition.x;
      const dy = c.y - cameraPosition.y;
      const dz = c.z - cameraPosition.z;
      const near = Math.sqrt(dx * dx + dy * dy + dz * dz) - entry.sphere.radius;
      entry.mesh.visible = near < entry.range;
    }
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

  /** Speed limit signs wherever the posted limit changes, and the guide signs. */
  buildSigns() {
    const route = this.route;
    for (const change of route.corridor.limitChanges()) {
      if (change.s < 10) continue;
      this.group.add(this.makeSpeedSign(change.s + 25, change.limitMph));
    }
    for (const sign of route.guideSigns ?? []) {
      this.group.add(this.makeGuideSign(sign));
    }
  }

  /**
   * A green guide sign on two posts.
   *
   * The ramps are the only places on this route where the driver has to know
   * something the road itself does not tell him -- which way the interstate
   * goes, and which exit comes off it -- and a sign is how a road says that.
   */
  makeGuideSign(sign) {
    const route = this.route;
    const lines = sign.text.split('\n');
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128 * lines.length;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d5c2f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 6;
    ctx.strokeRect(9, 9, canvas.width - 18, canvas.height - 18);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => {
      ctx.font = `bold ${i === 0 ? 62 : 48}px Arial`;
      ctx.fillText(line, canvas.width / 2, (i + 0.5) * (canvas.height / lines.length));
    });

    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const width = 4.6;
    const height = (width * canvas.height) / canvas.width;
    const board = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ map: tex, side: DoubleSide })
    );

    const side = sign.side ?? 1;
    const lateral = side * (route.halfWidthAt(sign.s) + 2.6);
    route.positionAt(sign.s, lateral, _p);
    const ground = this.ground.heightAt(_p.x, _p.z);
    const heading = route.headingAt(sign.s) + Math.PI;
    board.position.set(_p.x, ground + 5.2, _p.z);
    board.rotation.y = heading;

    const g = new Group();
    g.add(board);
    const postMat = new MeshStandardMaterial({ color: 0x777c82, metalness: 0.7, roughness: 0.5 });
    for (const dx of [-width * 0.32, width * 0.32]) {
      const post = new Mesh(new CylinderGeometry(0.09, 0.09, 5.2, 6), postMat);
      post.position.set(
        _p.x + Math.cos(heading) * dx, ground + 2.6, _p.z - Math.sin(heading) * dx
      );
      g.add(post);
    }
    return g;
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
