// A tiny architectural scene builder that turns primitive geometry into an
// optimized glTF binary (.glb).
//
// Geometry is collected per material and merged into one mesh per material,
// which keeps draw calls low. Textured materials can use world-space box
// projected UVs so tiling surfaces (floors, walls, stone) stay consistent
// regardless of object size.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Document, Logger, NodeIO } from "@gltf-transform/core";
import { dedup, meshopt, prune, quantize, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { EXTMeshoptCompression, KHRLightsPunctual, KHRMaterialsEmissiveStrength, KHRMeshQuantization } from "@gltf-transform/extensions";

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function hexToLinear(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
}

export class HouseBuilder {
  constructor() {
    this.textures = new Map();
    this.materials = new Map();
    this.parts = new Map();
    this.lights = [];
    this.stack = [new THREE.Matrix4()];
  }

  // --- registry ------------------------------------------------------------

  texture(name, img, format = "jpeg") {
    const data = format === "png" ? img.png() : img.jpeg();
    this.textures.set(name, { data, mime: format === "png" ? "image/png" : "image/jpeg" });
    return name;
  }

  /**
   * def: { color, roughness, metalness, map, emissive, emissiveMap, emissiveStrength,
   *        blend, opacity, doubleSided, uv: { mode: 'world'|'native', tile } }
   */
  material(name, def) {
    this.materials.set(name, { uv: { mode: "native" }, roughness: 0.8, metalness: 0, ...def });
    return name;
  }

  // --- transform stack -----------------------------------------------------

  get matrix() {
    return this.stack[this.stack.length - 1];
  }

  /** Run fn inside a local frame translated to pos and rotated by rotY (radians). */
  group(pos, rotY, fn) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY || 0),
      new THREE.Vector3(1, 1, 1),
    );
    this.stack.push(this.matrix.clone().multiply(m));
    try {
      fn();
    } finally {
      this.stack.pop();
    }
  }

  // --- primitives ----------------------------------------------------------

  add(mat, geom, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
    if (!this.materials.has(mat)) throw new Error(`Unknown material ${mat}`);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, "YXZ")),
      new THREE.Vector3(...scale),
    );
    for (const key of Object.keys(geom.attributes)) {
      if (!["position", "normal", "uv"].includes(key)) geom.deleteAttribute(key);
    }
    const g = geom.index ? geom : mergeVertices(geom, 1e-4);
    if (!g.index) indexed(g);
    g.clearGroups();
    g.applyMatrix4(this.matrix.clone().multiply(local));
    const def = this.materials.get(mat);
    if (def.uv.mode === "world") worldUV(g, def.uv.tile);
    if (!this.parts.has(mat)) this.parts.set(mat, []);
    this.parts.get(mat).push(g);
    return g;
  }

  /** Axis-aligned box from min/max corners (in the current local frame). */
  box(mat, min, max) {
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    if (size.some((s) => s <= 1e-4)) return;
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    this.add(mat, new THREE.BoxGeometry(...size), c);
  }

  /** Box by center/size with optional yaw. */
  cbox(mat, center, size, rotY = 0) {
    this.add(mat, new THREE.BoxGeometry(...size), center, [0, rotY, 0]);
  }

  rbox(mat, center, size, radius = 0.04, rotY = 0, segments = 2) {
    const r = Math.min(radius, ...size.map((s) => s / 2 - 1e-3));
    this.add(mat, new RoundedBoxGeometry(size[0], size[1], size[2], segments, r), center, [0, rotY, 0]);
  }

  cyl(mat, center, rTop, rBottom, h, segs = 24, rot = [0, 0, 0]) {
    this.add(mat, new THREE.CylinderGeometry(rTop, rBottom, h, segs), center, rot);
  }

  sphere(mat, center, r, scale = [1, 1, 1], detail = 2) {
    this.add(mat, new THREE.IcosahedronGeometry(r, detail), center, [0, 0, 0], scale);
  }

  torus(mat, center, r, tube, rot = [Math.PI / 2, 0, 0], segs = 48) {
    this.add(mat, new THREE.TorusGeometry(r, tube, 10, segs), center, rot);
  }

  /** Horizontal plane (e.g. contact shadow) centered at pos. */
  plane(mat, center, w, d, rotY = 0) {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    this.add(mat, g, center, [0, rotY, 0]);
  }

  /** Vertical plane facing +z in local frame. */
  vplane(mat, center, w, h, rotY = 0) {
    this.add(mat, new THREE.PlaneGeometry(w, h), center, [0, rotY, 0]);
  }

  light({ position, color = "#ffd9b0", intensity = 20, range = 9, name }) {
    const p = new THREE.Vector3(...position).applyMatrix4(this.matrix);
    this.lights.push({ position: p.toArray(), color, intensity, range, name });
  }

  // --- export --------------------------------------------------------------

  async toGLB({ name, extras }) {
    const doc = new Document().setLogger(new Logger(Logger.Verbosity.ERROR));
    doc.getRoot().getAsset().generator = "Atrium demo property generator";
    const buffer = doc.createBuffer();
    const scene = doc.createScene(name);
    const lightsExt = doc.createExtension(KHRLightsPunctual);
    const emissiveExt = doc.createExtension(KHRMaterialsEmissiveStrength);

    const texCache = new Map();
    const getTex = (texName) => {
      if (!texCache.has(texName)) {
        const t = this.textures.get(texName);
        if (!t) throw new Error(`Unknown texture ${texName}`);
        texCache.set(texName, doc.createTexture(texName).setImage(t.data).setMimeType(t.mime));
      }
      return texCache.get(texName);
    };

    let triangles = 0;
    for (const [matName, geoms] of this.parts) {
      const def = this.materials.get(matName);
      const mat = doc
        .createMaterial(matName)
        .setBaseColorFactor([...hexToLinear(def.color || "#ffffff"), def.opacity ?? 1])
        .setRoughnessFactor(def.roughness)
        .setMetallicFactor(def.metalness)
        .setDoubleSided(!!def.doubleSided);
      if (def.map) mat.setBaseColorTexture(getTex(def.map));
      if (def.emissive) mat.setEmissiveFactor(hexToLinear(def.emissive));
      if (def.emissiveMap) mat.setEmissiveTexture(getTex(def.emissiveMap));
      if (def.emissiveStrength && def.emissiveStrength !== 1) {
        mat.setExtension(
          "KHR_materials_emissive_strength",
          emissiveExt.createEmissiveStrength().setEmissiveStrength(def.emissiveStrength),
        );
      }
      if (def.blend) mat.setAlphaMode("BLEND");

      const merged = mergeGeometries(geoms, false);
      if (!merged) throw new Error(`Failed to merge ${matName}`);
      const pos = merged.getAttribute("position");
      const nor = merged.getAttribute("normal");
      const uv = merged.getAttribute("uv");
      const idx = merged.getIndex();
      triangles += idx.count / 3;
      const indexArray =
        pos.count < 65535 ? new Uint16Array(idx.array) : new Uint32Array(idx.array);
      const prim = doc
        .createPrimitive()
        .setMaterial(mat)
        .setAttribute(
          "POSITION",
          doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos.array)).setBuffer(buffer),
        )
        .setAttribute(
          "NORMAL",
          doc.createAccessor().setType("VEC3").setArray(new Float32Array(nor.array)).setBuffer(buffer),
        )
        .setAttribute(
          "TEXCOORD_0",
          doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv.array)).setBuffer(buffer),
        )
        .setIndices(doc.createAccessor().setType("SCALAR").setArray(indexArray).setBuffer(buffer));
      const mesh = doc.createMesh(matName).addPrimitive(prim);
      scene.addChild(doc.createNode(matName).setMesh(mesh));
    }

    this.lights.forEach((l, i) => {
      const light = lightsExt
        .createLight(l.name || `light_${i}`)
        .setType("point")
        .setColor(hexToLinear(l.color))
        .setIntensity(l.intensity)
        .setRange(l.range);
      scene.addChild(
        doc
          .createNode(l.name || `light_${i}`)
          .setTranslation(l.position)
          .setExtension("KHR_lights_punctual", light),
      );
    });

    if (extras) scene.setExtras(extras);
    await MeshoptEncoder.ready;
    await doc.transform(
      dedup(),
      weld(),
      prune(),
      quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
      meshopt({ encoder: MeshoptEncoder, level: "medium" }),
    );
    const glb = await new NodeIO()
      .registerExtensions([KHRLightsPunctual, KHRMaterialsEmissiveStrength, KHRMeshQuantization, EXTMeshoptCompression])
      .registerDependencies({ "meshopt.encoder": MeshoptEncoder })
      .writeBinary(doc);
    return { glb, triangles };
  }
}

function indexed(geom) {
  const count = geom.getAttribute("position").count;
  const arr = count < 65535 ? new Uint16Array(count) : new Uint32Array(count);
  for (let i = 0; i < count; i++) arr[i] = i;
  geom.setIndex(new THREE.BufferAttribute(arr, 1));
  return geom;
}

/** Replace UVs with world-space box projection (tile = meters per texture repeat). */
function worldUV(g, tile = 1) {
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  const uv = g.getAttribute("uv");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, x / tile, z / tile);
    else if (ax >= az) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  uv.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Architectural helpers
// ---------------------------------------------------------------------------

/**
 * Build one side of a room as a half-thickness wall with openings, trim and
 * windows. Each room builds the inner half of its own walls, so adjacent
 * rooms can have different finishes on either side of a shared wall.
 *
 * run: { axis: 'x'|'z', at, from, to, side: +1|-1, y0, y1, t, mat, trim, ext,
 *        openings: [{ a, b, y0, y1, kind: 'door'|'opening'|'window' }], window: {...mats} }
 *   axis 'x' => wall runs along x at z = at; 'z' => wall runs along z at x = at.
 *   side => direction from the wall line toward the room interior.
 */
export function buildWallRun(b, run) {
  const { axis, at, from, to, side, y0, y1, t, mat, trim, openings = [] } = run;
  const ops = openings
    .map((o) => ({ ...o, a: Math.max(o.a, from), b: Math.min(o.b, to) }))
    .filter((o) => o.b - o.a > 0.01)
    .sort((p, q) => p.a - q.a);

  const inner = at + side * t;
  const depth = [Math.min(at, inner), Math.max(at, inner)];
  const put = (m, a0, a1, h0, h1, d0 = depth[0], d1 = depth[1]) => {
    if (a1 - a0 < 1e-3 || h1 - h0 < 1e-3) return;
    if (axis === "x") b.box(m, [a0, h0, d0], [a1, h1, d1]);
    else b.box(m, [d0, h0, a0], [d1, h1, a1]);
  };

  // Solid wall pieces.
  let cursor = from;
  for (const o of ops) {
    put(mat, cursor, o.a, y0, y1);
    put(mat, o.a, o.b, y0, Math.max(y0, o.y0));
    put(mat, o.a, o.b, Math.min(y1, o.y1), y1);
    cursor = o.b;
  }
  put(mat, cursor, to, y0, y1);

  const proud = (d) => (side > 0 ? [inner, inner + d] : [inner - d, inner]);

  if (trim) {
    // Baseboards (skip floor-level openings).
    const baseH = 0.13;
    let c2 = from;
    for (const o of ops) {
      if (o.y0 <= y0 + 0.02) {
        put(trim, c2, o.a, y0, y0 + baseH, ...proud(0.016));
        c2 = o.b;
      }
  }
  put(trim, c2, to, y0, y0 + baseH, ...proud(0.016));

  // Crown molding.
  const crownH = 0.09;
  let c3 = from;
  for (const o of ops) {
    if (o.y1 >= y1 - 0.02) {
      put(trim, c3, o.a, y1 - crownH, y1, ...proud(0.03));
      c3 = o.b;
    }
  }
  put(trim, c3, to, y1 - crownH, y1, ...proud(0.03));
  }

  for (const o of ops) {
    if ((o.kind === "door" || o.kind === "opening") && trim) {
      // Casings around the opening on this side.
      const w = 0.075;
      put(trim, o.a - w, o.a, y0, o.y1 + w, ...proud(0.02));
      put(trim, o.b, o.b + w, y0, o.y1 + w, ...proud(0.02));
      put(trim, o.a - w, o.b + w, o.y1, o.y1 + w, ...proud(0.022));
      // Jamb liners so the cut through the wall looks finished.
      if (axis === "x") {
        b.box(trim, [o.a, y0, depth[0]], [o.a + 0.012, o.y1, depth[1]]);
        b.box(trim, [o.b - 0.012, y0, depth[0]], [o.b, o.y1, depth[1]]);
      } else {
        b.box(trim, [depth[0], y0, o.a], [depth[1], o.y1, o.a + 0.012]);
        b.box(trim, [depth[0], y0, o.b - 0.012], [depth[1], o.y1, o.b]);
      }
    } else if (o.kind === "window" && run.window) {
      const { pane, frame, sill } = run.window;
      // Interior sill.
      if (o.y0 > y0 + 0.05) put(sill, o.a - 0.06, o.b + 0.06, o.y0 - 0.035, o.y0, ...proud(0.05));
      // Glass "daylight" pane set near the exterior face → deep reveal.
      const paneD = at + side * 0.03;
      const pd = [Math.min(paneD, paneD + side * 0.01), Math.max(paneD, paneD + side * 0.01)];
      put(pane, o.a, o.b, o.y0, o.y1, ...pd);
      // Slim black frame + mullions.
      const fw = 0.045;
      const fd = [Math.min(paneD, paneD + side * 0.05), Math.max(paneD, paneD + side * 0.05)];
      put(frame, o.a, o.a + fw, o.y0, o.y1, ...fd);
      put(frame, o.b - fw, o.b, o.y0, o.y1, ...fd);
      put(frame, o.a, o.b, o.y0, o.y0 + fw, ...fd);
      put(frame, o.a, o.b, o.y1 - fw, o.y1, ...fd);
      const width = o.b - o.a;
      const mullions = width > 2.4 ? 3 : width > 1.3 ? 2 : 1;
      for (let i = 1; i < mullions; i++) {
        const m = o.a + (width * i) / mullions;
        put(frame, m - fw / 2, m + fw / 2, o.y0, o.y1, ...fd);
      }
      if (o.y1 - o.y0 > 1.6) {
        const tr = o.y1 - (o.y1 - o.y0) * 0.24;
        put(frame, o.a, o.b, tr - fw / 2, tr + fw / 2, ...fd);
      }
    }
  }
}
