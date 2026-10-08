// Renders the "real" apartment for the photoreal prototype. Exposes window.gt.* for render.mjs.
import * as THREE from "three";
import { buildApartment, addLights, KIND } from "./apartment.js";

const W = 480, Hpx = 360;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, Hpx);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
document.body.appendChild(renderer.domElement);

const { scene, meta, mirrors } = buildApartment();
scene.background = new THREE.Color("#cfe2f3");
addLights(scene);
const camera = new THREE.PerspectiveCamera(50, W / Hpx, 0.05, 40);
camera.matrixAutoUpdate = false;

// Reflections for glossy and metal surfaces: the apartment itself, seen from the kitchen doorway.
{
  const target = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cube = new THREE.CubeCamera(0.05, 30, target);
  cube.position.set(5.06, 1.3, 2.0);
  scene.add(cube);
  for (const m of mirrors) m.visible = false;
  cube.update(renderer, scene);
  for (const m of mirrors) m.visible = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromCubemap(target.texture).texture;
  renderer.shadowMap.needsUpdate = true;
}

function setCamera(m, fy, w, h) {
  if (renderer.domElement.width !== w || renderer.domElement.height !== h) renderer.setSize(w, h);
  camera.fov = (2 * Math.atan(h / 2 / fy) * 180) / Math.PI;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  camera.matrixWorld.fromArray(m);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
}

window.gt = {
  ready: true,
  /** Camera-to-world (16 numbers, column-major, −Z forward), focal length in pixels, image size → PNG data URL. */
  render(m, fy, w = W, h = Hpx) {
    setCamera(m, fy, w, h);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/png");
  },
  /** Every triangle in world space (9 floats each), with its kind and room, base64. */
  triangles() {
    scene.updateMatrixWorld(true);
    const pos = [], kinds = [], rooms = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (const { mesh, kind, room } of meta) {
      const g = mesh.geometry;
      const p = g.attributes.position;
      const idx = g.index ? g.index.array : null;
      const n = idx ? idx.length : p.count;
      for (let i = 0; i + 2 < n; i += 3) {
        const ia = idx ? idx[i] : i, ib = idx ? idx[i + 1] : i + 1, ic = idx ? idx[i + 2] : i + 2;
        a.fromBufferAttribute(p, ia).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(p, ib).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(p, ic).applyMatrix4(mesh.matrixWorld);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        kinds.push(kind);
        rooms.push(room);
      }
    }
    const f = new Float32Array(pos);
    const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
    return { positions: toB64(new Uint8Array(f.buffer)), kinds: toB64(new Uint8Array(kinds)), rooms: toB64(new Uint8Array(rooms)), count: kinds.length };
  },
};
