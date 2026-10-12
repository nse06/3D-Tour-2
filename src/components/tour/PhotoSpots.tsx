"use client";

/* eslint-disable react-hooks/immutability -- three.js objects and shader uniforms are mutated imperatively from the render loop, as is idiomatic with React Three Fiber. */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Photo spots of a remastered model (docs/remaster.md §4.6): where the photos were taken, the
 * worker rendered a cube of what they saw (worker/remaster/atrium_remaster/spots.py). Near a spot
 * the model shows its photos, projected onto the model from the spot (so they sit on the walls and
 * furniture they show, and what the spot couldn't see keeps the model's own skins); between spots
 * the two nearest blend, and away from them the model shows alone.
 */

export interface PhotoSpot {
  position: [number, number, number];
  /** One JPEG: the cube's six faces in a 3 × 2 grid, +x −x +y over −y +z −z (OpenGL's layout). */
  image: string;
  photos: number;
}

/** The photo spots a remastered model lists in its scene's extras, or none. */
export function spotsOf(scene: THREE.Object3D | null): PhotoSpot[] {
  const data = scene?.userData?.atriumSpots as { version?: unknown; spots?: unknown } | undefined;
  if (!data || data.version !== 1 || !Array.isArray(data.spots)) return [];
  return data.spots
    .filter(
      (s): s is PhotoSpot =>
        !!s &&
        Array.isArray(s.position) &&
        s.position.length === 3 &&
        s.position.every((v: unknown) => typeof v === "number" && Number.isFinite(v)) &&
        typeof s.image === "string" &&
        s.image.length > 0,
    )
    .slice(0, 250);
}

/** A spot's photos show fully within FULL meters of it and fade out by RANGE. */
const FULL = 0.12;
const RANGE = 1.6;
/** Spots kept loaded (each a cube of photos and a cube of distances). */
const CACHE = 3;
const DISTANCE_SIZE = 256;
const FAR = 40;

export interface SpotUniforms {
  spotCube0: THREE.IUniform<THREE.Texture | null>;
  spotCube1: THREE.IUniform<THREE.Texture | null>;
  spotDist0: THREE.IUniform<THREE.Texture | null>;
  spotDist1: THREE.IUniform<THREE.Texture | null>;
  spotPos0: THREE.IUniform<THREE.Vector3>;
  spotPos1: THREE.IUniform<THREE.Vector3>;
  spotWeight0: THREE.IUniform<number>;
  spotWeight1: THREE.IUniform<number>;
  spotFar: THREE.IUniform<number>;
  [name: string]: THREE.IUniform;
}

export function makeSpotUniforms(): SpotUniforms {
  return {
    spotCube0: { value: null },
    spotCube1: { value: null },
    spotDist0: { value: null },
    spotDist1: { value: null },
    spotPos0: { value: new THREE.Vector3() },
    spotPos1: { value: new THREE.Vector3() },
    spotWeight0: { value: 0 },
    spotWeight1: { value: 0 },
    spotFar: { value: FAR },
  };
}

const PACK = /* glsl */ `
vec4 spotPack(float v) {
  vec4 enc = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * v);
  return enc - enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
}
float spotUnpack(vec4 v) { return dot(v, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }
`;

const SPOT_PARS = /* glsl */ `
uniform samplerCube spotCube0;
uniform samplerCube spotCube1;
uniform samplerCube spotDist0;
uniform samplerCube spotDist1;
uniform vec3 spotPos0;
uniform vec3 spotPos1;
uniform float spotWeight0;
uniform float spotWeight1;
uniform float spotFar;
varying vec3 vSpotWorld;
${PACK}
// Whether the spot saw this point: nothing nearer along the way (its cube of distances).
float spotSees(samplerCube distances, vec3 d) {
  float seen = spotUnpack(textureCube(distances, d)) * spotFar;
  float here = length(d);
  return here < seen + 0.04 + 0.02 * here ? 1.0 : 0.0;
}
`;

const SPOT_FRAGMENT = /* glsl */ `
{
  vec3 spotColor = vec3(0.0);
  float spotSay = 0.0;
  if (spotWeight0 > 0.001) {
    vec3 d = vSpotWorld - spotPos0;
    float w = spotWeight0 * spotSees(spotDist0, d);
    spotColor += w * textureCube(spotCube0, d).rgb;
    spotSay += w;
  }
  if (spotWeight1 > 0.001) {
    vec3 d = vSpotWorld - spotPos1;
    float w = spotWeight1 * spotSees(spotDist1, d);
    spotColor += w * textureCube(spotCube1, d).rgb;
    spotSay += w;
  }
  if (spotSay > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, spotColor / spotSay, min(spotSay, 1.0));
}
`;

/** Teach an (unlit) material of the remastered model to show the photo spots. */
export function withPhotoSpots(material: THREE.Material, uniforms: SpotUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSpotWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvSpotWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SPOT_PARS}`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${SPOT_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => "atrium-photo-spots";
  material.needsUpdate = true;
}

interface Loaded {
  state: "loading" | "ready" | "failed";
  cube: THREE.CubeTexture | null;
  distances: THREE.WebGLCubeRenderTarget | null;
  used: number;
}

/** The six faces of a spot's picture as a cube texture (WebGL samples them as stored). */
function cubeFrom(image: HTMLImageElement): THREE.CubeTexture {
  const n = Math.floor(image.height / 2);
  const faces = [0, 1, 2, 3, 4, 5].map((k) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = n;
    canvas.getContext("2d")!.drawImage(image, (k % 3) * n, Math.floor(k / 3) * n, n, n, 0, 0, n, n);
    return canvas;
  });
  const cube = new THREE.CubeTexture(faces);
  cube.colorSpace = THREE.SRGBColorSpace;
  cube.generateMipmaps = true;
  cube.minFilter = THREE.LinearMipmapLinearFilter;
  cube.needsUpdate = true;
  return cube;
}

export function PhotoSpots({
  scene: model,
  spots,
  uniforms,
  active,
}: {
  /** The remastered model's scene. */
  scene: THREE.Object3D | null;
  spots: PhotoSpot[];
  uniforms: SpotUniforms;
  /** The remastered model is on screen. */
  active: boolean;
}) {
  const { gl, camera, invalidate } = useThree();
  const cache = useRef(new Map<number, Loaded>());
  const frame = useRef(0);
  const markers = useRef<THREE.InstancedMesh>(null);
  const positions = useMemo(() => spots.map((s) => new THREE.Vector3(...s.position)), [spots]);

  // What the spots render their distances from: the model alone, every surface writing its distance.
  const distance = useMemo(() => {
    if (!model) return null;
    const scene = new THREE.Scene();
    scene.add(model.clone(true));
    const material = new THREE.ShaderMaterial({
      uniforms: { spotPos: { value: new THREE.Vector3() }, spotFar: { value: FAR } },
      vertexShader: "varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
      fragmentShader: `uniform vec3 spotPos; uniform float spotFar; varying vec3 vWorld; ${PACK} void main() { gl_FragColor = spotPack(clamp(length(vWorld - spotPos) / spotFar, 0.0, 0.9999)); }`,
      side: THREE.DoubleSide,
    });
    scene.overrideMaterial = material;
    return { scene, material };
  }, [model]);

  // A new model (or none): let go of the old spots.
  useEffect(() => {
    const loaded = cache.current;
    return () => {
      loaded.forEach((l) => {
        l.cube?.dispose();
        l.distances?.dispose();
      });
      loaded.clear();
      uniforms.spotWeight0.value = uniforms.spotWeight1.value = 0;
      uniforms.spotCube0.value = uniforms.spotCube1.value = uniforms.spotDist0.value = uniforms.spotDist1.value = null;
      distance?.material.dispose();
    };
  }, [spots, distance, uniforms]);

  // The rings on the floor where the spots are.
  useEffect(() => {
    const mesh = markers.current;
    if (!mesh || !model) return;
    const ray = new THREE.Raycaster();
    const m = new THREE.Matrix4();
    positions.forEach((p, i) => {
      ray.set(p, new THREE.Vector3(0, -1, 0));
      ray.far = 3;
      const hit = ray.intersectObject(model, true)[0];
      const y = hit ? hit.point.y + 0.01 : p.y - 1.4;
      m.makeRotationX(-Math.PI / 2).setPosition(p.x, y, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.count = positions.length;
    mesh.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [positions, model, invalidate]);

  const load = (i: number): Loaded => {
    let entry = cache.current.get(i);
    if (entry) return entry;
    entry = { state: "loading", cube: null, distances: null, used: frame.current };
    cache.current.set(i, entry);
    const loading = entry;
    // Its distances, from the model, right away.
    if (distance) {
      const target = new THREE.WebGLCubeRenderTarget(DISTANCE_SIZE, {
        type: THREE.UnsignedByteType,
        generateMipmaps: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
      const cubeCamera = new THREE.CubeCamera(0.03, FAR, target);
      cubeCamera.position.copy(positions[i]);
      distance.material.uniforms.spotPos.value.copy(positions[i]);
      const clear = gl.getClearColor(new THREE.Color());
      const alpha = gl.getClearAlpha();
      gl.setClearColor(0xffffff, 1);
      cubeCamera.update(gl, distance.scene);
      gl.setClearColor(clear, alpha);
      loading.distances = target;
    }
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      if (cache.current.get(i) !== loading) return;
      loading.cube = cubeFrom(image);
      loading.state = loading.distances ? "ready" : "failed";
      invalidate();
    };
    image.onerror = () => {
      loading.state = "failed";
    };
    image.src = spots[i].image;
    // Keep a few: the least recently used goes.
    if (cache.current.size > CACHE) {
      const [oldest] = [...cache.current.entries()].filter(([k]) => k !== i).sort((a, b) => a[1].used - b[1].used);
      if (oldest) {
        oldest[1].cube?.dispose();
        oldest[1].distances?.dispose();
        cache.current.delete(oldest[0]);
      }
    }
    return entry;
  };

  useFrame(() => {
    frame.current++;
    const mesh = markers.current;
    if (mesh) mesh.visible = active && positions.length > 0;
    let w0 = 0;
    let w1 = 0;
    let a = -1;
    let b = -1;
    if (active && positions.length) {
      // The two nearest spots, each weighed by how near it is.
      let da = Infinity;
      let db = Infinity;
      positions.forEach((p, i) => {
        const d = p.distanceTo(camera.position);
        if (d < da) {
          db = da;
          b = a;
          da = d;
          a = i;
        } else if (d < db) {
          db = d;
          b = i;
        }
      });
      const weight = (d: number) => (d <= FULL ? 1 : Math.max(0, 1 - (d - FULL) / (RANGE - FULL)));
      const ready = (i: number) => {
        if (i < 0) return null;
        const entry = load(i);
        entry.used = frame.current;
        return entry.state === "ready" ? entry : null;
      };
      const ea = da < RANGE ? ready(a) : null;
      const eb = db < RANGE ? ready(b) : null;
      w0 = ea ? weight(da) : 0;
      w1 = eb ? weight(db) : 0;
      const sum = w0 + w1;
      if (sum > 1) {
        w0 /= sum;
        w1 /= sum;
      }
      if (ea) uniforms.spotPos0.value.copy(positions[a]);
      if (eb) uniforms.spotPos1.value.copy(positions[b]);
      // A slot not in use lets go of its spot (which may be dropped from the cache).
      uniforms.spotCube0.value = ea?.cube ?? null;
      uniforms.spotDist0.value = ea?.distances?.texture ?? null;
      uniforms.spotCube1.value = eb?.cube ?? null;
      uniforms.spotDist1.value = eb?.distances?.texture ?? null;
    } else {
      uniforms.spotCube0.value = uniforms.spotDist0.value = uniforms.spotCube1.value = uniforms.spotDist1.value = null;
    }
    uniforms.spotWeight0.value = w0;
    uniforms.spotWeight1.value = w1;
  });

  return (
    <instancedMesh ref={markers} args={[undefined, undefined, Math.max(1, positions.length)]} renderOrder={9} frustumCulled={false}>
      <ringGeometry args={[0.13, 0.17, 40]} />
      <meshBasicMaterial color="#ffffff" transparent opacity={0.55} depthWrite={false} toneMapped={false} />
    </instancedMesh>
  );
}
