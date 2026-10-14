"use client";

/* eslint-disable react-hooks/immutability -- three.js objects and shader uniforms are mutated imperatively from the render loop, as is idiomatic with React Three Fiber. */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { renderSpotDistances, spotDistanceMaterial, type SpotUniforms } from "./photo-spot-shader";

/**
 * Photo spots of a remastered model (docs/remaster.md §4.6): where the photos were taken, the
 * worker rendered a cube of what they saw (worker/remaster/atrium_remaster/spots.py). Near a spot
 * the model shows its photos, projected onto the model from the spot (so they sit on the walls and
 * furniture they show, and what the spot couldn't see keeps the model's own skins). One spot shows
 * at a time, crossfading to the next as the visitor walks, and away from the spots the model shows
 * alone. How much of a spot's photo shows at each point (where the model's shapes are off, as
 * little as can be): photo-spot-shader.ts.
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
const FULL = 0.6;
const RANGE = 1.6;
/** Another spot takes over once it's this much nearer than the one showing (meters), the two
 * crossfading over FADE seconds. */
const SWITCH = 0.15;
const FADE = 0.45;
/** Spots kept loaded (each a cube of photos and a cube of distances). */
const CACHE = 3;

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
  // The spot showing, the one it took over from and how far along the crossfade is (0–1).
  const shown = useRef({ current: -1, previous: -1, fade: 1 });
  const positions = useMemo(() => spots.map((s) => new THREE.Vector3(...s.position)), [spots]);

  // What the spots render their distances from: the model alone, every surface writing its distance.
  const distance = useMemo(() => {
    if (!model) return null;
    const scene = new THREE.Scene();
    scene.add(model.clone(true));
    const material = spotDistanceMaterial();
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

  const load = (i: number): Loaded => {
    let entry = cache.current.get(i);
    if (entry) return entry;
    entry = { state: "loading", cube: null, distances: null, used: frame.current };
    cache.current.set(i, entry);
    const loading = entry;
    // Its distances, from the model, right away.
    if (distance) loading.distances = renderSpotDistances(gl, distance.scene, distance.material, positions[i]);
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

  useFrame((_, dt) => {
    frame.current++;
    const show = shown.current;
    let w0 = 0;
    let w1 = 0;
    let current: Loaded | null = null;
    let previous: Loaded | null = null;
    if (active && positions.length) {
      // One spot at a time, so nothing shows twice where the model's shapes are off: the nearest,
      // until another is clearly nearer; then the two crossfade.
      const distance = (i: number) => (i < 0 ? Infinity : positions[i].distanceTo(camera.position));
      let nearest = 0;
      positions.forEach((_, i) => {
        if (distance(i) < distance(nearest)) nearest = i;
      });
      if (nearest !== show.current && (distance(nearest) < distance(show.current) - SWITCH || distance(show.current) >= RANGE)) {
        show.previous = show.current;
        show.current = nearest;
        show.fade = 0;
      }
      const weight = (d: number) => (d <= FULL ? 1 : Math.max(0, 1 - (d - FULL) / (RANGE - FULL)));
      const ready = (i: number) => {
        if (i < 0 || distance(i) >= RANGE) return null;
        const entry = load(i);
        entry.used = frame.current;
        return entry.state === "ready" ? entry : null;
      };
      current = ready(show.current);
      // The new spot fades in once its pictures are there; till then the old one stays.
      if (current) show.fade = Math.min(1, show.fade + dt / FADE);
      previous = show.fade < 1 ? ready(show.previous) : null;
      const f = show.fade * show.fade * (3 - 2 * show.fade);
      w0 = current ? weight(distance(show.current)) * f : 0;
      w1 = previous ? weight(distance(show.previous)) * (1 - f) : 0;
      if (current) uniforms.spotPos0.value.copy(positions[show.current]);
      if (previous) uniforms.spotPos1.value.copy(positions[show.previous]);
    }
    // A slot not in use lets go of its spot (which may be dropped from the cache).
    uniforms.spotCube0.value = current?.cube ?? null;
    uniforms.spotDist0.value = current?.distances?.texture ?? null;
    uniforms.spotCube1.value = previous?.cube ?? null;
    uniforms.spotDist1.value = previous?.distances?.texture ?? null;
    uniforms.spotWeight0.value = w0;
    uniforms.spotWeight1.value = w1;
  });

  // No markers on the floor: the walkthrough is free to walk, and the photos blend in near their spots.
  return null;
}
