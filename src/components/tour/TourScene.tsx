"use client";

/* eslint-disable react-hooks/immutability -- three.js scene objects are mutated imperatively, as is idiomatic with React Three Fiber. */

import { Bvh } from "@react-three/drei";
import { EffectComposer, N8AO, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { SplatSpot, TourAppearance, TourSpace, Waypoint } from "@/lib/tour/types";
import { CameraRig } from "./CameraRig";
import type { LivePose, ViewerApi, ViewerMode } from "./viewer-types";

export interface TourSceneProps {
  assetUrl: string;
  /** iPhone photo scans: the same rooms as a clean model, shown instead when `photos` is false. */
  cleanAssetUrl?: string | null;
  /** Photos on (the default) or off — off shows `cleanAssetUrl`, loaded the first time it's asked for. */
  photos?: boolean;
  /** Which model is on screen: true while the clean one shows. */
  onShowingClean?: (clean: boolean) => void;
  /** The model asked for by a switch couldn't be loaded; the starting one stays on screen. */
  onSwitchError?: (message: string) => void;
  /** Photoreal Gaussian splats (.spz) in the model's frame (docs/photoreal.md). */
  splatUrl?: string | null;
  /** Show the splats instead of the models (loaded the first time it's asked for). */
  photoreal?: boolean;
  /** How the splats are doing: loading, on screen, or failed (the models stay on screen). */
  onSplatState?: (state: "loading" | "ready" | "failed", message?: string) => void;
  /** Where the photos the splats were trained on were taken (photoreal is only shown near them). */
  splatSpots?: SplatSpot[] | null;
  /** Photoreal is on but paused: up close or away from the photos, the painted model shows. */
  onSplatPaused?: (paused: boolean) => void;
  space: TourSpace;
  startWaypoint: Waypoint;
  apiRef: MutableRefObject<ViewerApi | null>;
  poseRef: MutableRefObject<LivePose>;
  active: boolean;
  mode: ViewerMode;
  onRoomChange: (roomId: string | null) => void;
  onMovingChange: (moving: boolean) => void;
  onFade: (visible: boolean) => void;
  onProgress: (fraction: number) => void;
  onLoaded: () => void;
  onError: (message: string) => void;
  /** "captured": show the textures unlit, exactly as scanned (photo-textured captures). */
  appearance?: TourAppearance;
  /** Screen-space ambient occlusion; enabled on desktop-class GPUs. */
  effects?: boolean;
  autoPan?: boolean;
  onUserInteract?: () => void;
}

/** Fully client-side WebGL scene. Loaded with next/dynamic (ssr: false). */
export default function TourScene(props: TourSceneProps) {
  const { startWaypoint } = props;
  return (
    <Canvas
      className="!absolute inset-0 touch-none select-none"
      dpr={[1, 1.75]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: 76, near: 0.05, far: 160, position: startWaypoint.position }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
    >
      <color attach="background" args={["#e7e2da"]} />
      <SceneErrorBoundary onError={props.onError}>
        <Suspense fallback={null}>
          <PropertyModel {...props} />
        </Suspense>
      </SceneErrorBoundary>
    </Canvas>
  );
}

function configureLoader(loader: GLTFLoader) {
  const draco = new DRACOLoader();
  draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
}

/** Transparent surfaces don't write depth; contact shadows sit just above the floor and can't be picked. */
function prepareScene(scene: THREE.Object3D) {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) {
      if (!m.transparent) continue;
      m.depthWrite = false;
      mesh.userData.noPick = m.name !== "Contact_Shadow";
      if (m.name === "Contact_Shadow") {
        m.polygonOffset = true;
        m.polygonOffsetFactor = -2;
        mesh.renderOrder = 1;
      }
    }
  });
}

function countLights(scene: THREE.Object3D | null) {
  let lights = 0;
  scene?.traverse((o) => {
    if ((o as THREE.Light).isLight) lights++;
  });
  return lights;
}

function PropertyModel({
  assetUrl,
  cleanAssetUrl = null,
  photos = true,
  onShowingClean,
  onSwitchError,
  splatUrl = null,
  photoreal = false,
  onSplatState,
  splatSpots = null,
  onSplatPaused,
  space,
  startWaypoint,
  apiRef,
  poseRef,
  active,
  mode,
  onRoomChange,
  onMovingChange,
  onFade,
  onProgress,
  onLoaded,
  appearance = "studio",
  effects = false,
  autoPan = false,
  onUserInteract,
}: TourSceneProps) {
  // The camera rig picks floors and checks sight lines against the model on screen.
  const modelRef = useRef<THREE.Object3D | null>(null);
  // The models, shown unless the photoreal splats cover them (SplatLayer decides frame by frame).
  const modelsRef = useRef<THREE.Group>(null);
  // The model asked for at the start loads with the scene (and drives the progress bar); the
  // other one loads the first time the visitor switches, while this one stays on screen.
  const wantClean = !!cleanAssetUrl && !photos;
  const [primaryIsClean] = useState(wantClean);
  const primaryUrl = primaryIsClean && cleanAssetUrl ? cleanAssetUrl : assetUrl;
  const alternateUrl = primaryIsClean ? assetUrl : cleanAssetUrl;
  const gltf = useLoader(GLTFLoader, primaryUrl, configureLoader, (event) => {
    if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
  });
  const [alternate, setAlternate] = useState<THREE.Object3D | null>(null);
  const [alternateAsked, setAlternateAsked] = useState(false);
  const [alternateFailed, setAlternateFailed] = useState(false);
  if (wantClean !== primaryIsClean && !alternateAsked && !alternateFailed) setAlternateAsked(true);
  const showingClean = wantClean === primaryIsClean || !alternate ? primaryIsClean : wantClean;
  const showingPrimary = showingClean === primaryIsClean;
  const onScreen = showingPrimary ? gltf.scene : alternate;

  useLayoutEffect(() => {
    modelRef.current = onScreen;
  }, [onScreen]);
  useEffect(() => {
    onShowingClean?.(showingClean);
  }, [showingClean, onShowingClean]);

  // Captures may or may not ship their own lights (the demo and clean models do; photo models
  // don't). Balance image-based lighting accordingly.
  const hasLights = useMemo(() => countLights(onScreen) > 0, [onScreen]);

  useLayoutEffect(() => {
    prepareScene(gltf.scene);
    onLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltf]);

  // With a clean model to switch to, the photo model always shows as captured (unlit); without
  // one, `appearance` picks its lighting.
  const photoScene = primaryIsClean ? alternate : gltf.scene;
  const photoLook: TourAppearance = cleanAssetUrl ? "captured" : appearance;
  useLayoutEffect(() => {
    if (!photoScene || photoLook !== "captured") return;
    return showUnlit(photoScene);
  }, [photoScene, photoLook]);

  // Photoreal splats load the first time they're asked for; until they're ready (or if they
  // fail) the models stay on screen. The models keep doing the walking either way: the rig picks
  // floors and sight lines on them, hidden or not. Where the splats are unreliable (up close, away
  // from the photos), SplatLayer hands the view back to the painted model.
  const [splatAsked, setSplatAsked] = useState(false);
  const [splatReady, setSplatReady] = useState(false);
  if (photoreal && splatUrl && !splatAsked) setSplatAsked(true);
  const showSplats = photoreal && splatReady;

  const captured = showSplats || (showingClean ? "studio" : photoLook) === "captured";
  return (
    <>
      {!captured && <EnvironmentLighting intensity={hasLights ? 0.9 : 1.15} />}
      {!captured && <hemisphereLight args={["#fff8ee", "#b9ab98", hasLights ? 0.5 : 0.75]} />}
      <group ref={modelsRef}>
        <group visible={showingPrimary}>
          <Bvh firstHitOnly>
            <primitive object={gltf.scene} />
          </Bvh>
        </group>
        {alternateAsked && alternateUrl && (
          <SceneErrorBoundary
            onError={(message) => {
              setAlternateFailed(true);
              setAlternateAsked(false);
              onSwitchError?.(message);
            }}
          >
            <Suspense fallback={null}>
              <AlternateModel url={alternateUrl} visible={!showingPrimary} onReady={setAlternate} />
            </Suspense>
          </SceneErrorBoundary>
        )}
      </group>
      {splatAsked && splatUrl && (
        <SplatLayer
          url={splatUrl}
          visible={showSplats}
          modelRef={modelRef}
          modelsRef={modelsRef}
          spots={splatSpots}
          onPaused={onSplatPaused}
          onState={(state, message) => {
            if (state === "ready") setSplatReady(true);
            onSplatState?.(state, message);
          }}
        />
      )}
      <CameraRig
        space={space}
        modelRef={modelRef}
        apiRef={apiRef}
        poseRef={poseRef}
        startWaypoint={startWaypoint}
        active={active}
        mode={mode}
        onRoomChange={onRoomChange}
        onMovingChange={onMovingChange}
        onFade={onFade}
        autoPan={autoPan}
        onUserInteract={onUserInteract}
        photoScan={photoLook === "captured"}
      />
      {effects && !captured && (
        <EffectComposer multisampling={4}>
          <N8AO aoRadius={0.6} distanceFalloff={0.7} intensity={2.4} quality="medium" halfRes />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
      )}
    </>
  );
}

/** Up close, splats trained on photos taken a step or two away smear: below this (median distance to
 * what's in view, in meters) the painted model takes over, and photoreal returns past RESUME. */
const SPLAT_NEAR_PAUSE = 0.9;
const SPLAT_NEAR_RESUME = 1.15;
/** A photo counts as covering the view within this distance (m) and angle of it (pause / resume). */
const SPOT_RANGE = { pause: 1.4, resume: 1.05 };
const SPOT_ANGLE = { pause: Math.cos((70 * Math.PI) / 180), resume: Math.cos((55 * Math.PI) / 180) };
const SPLAT_FADE_SECONDS = 0.35;
/** Where in the view to measure distance (normalized device coordinates). */
const PROBES: [number, number][] = [-0.5, 0, 0.5].flatMap((x) => [-0.45, 0, 0.45].map((y) => [x, y] as [number, number]));
const probe = new THREE.Vector2();
const forward = new THREE.Vector3();

/**
 * Photoreal Gaussian splats (Spark, loaded on first use). Rendered like gsplat trained them:
 * splats out to 3 standard deviations, with gsplat's 0.3-pixel² screen-space blur. Splats are only
 * as good as the photos they learned from, so they fade to the painted model when the view is
 * close to a surface or not near where a photo looked the same way, and come back after.
 */
function SplatLayer({
  url,
  visible,
  modelRef,
  modelsRef,
  spots,
  onPaused,
  onState,
}: {
  url: string;
  visible: boolean;
  modelRef: MutableRefObject<THREE.Object3D | null>;
  modelsRef: MutableRefObject<THREE.Group | null>;
  spots: SplatSpot[] | null;
  onPaused?: (paused: boolean) => void;
  onState: (state: "loading" | "ready" | "failed", message?: string) => void;
}) {
  const { gl, scene, camera, raycaster, invalidate } = useThree();
  const [layer, setLayer] = useState<{ spark: THREE.Object3D; splats: THREE.Object3D & { opacity: number } } | null>(null);
  const report = useRef(onState);
  const reportPaused = useRef(onPaused);
  useLayoutEffect(() => {
    report.current = onState;
    reportPaused.current = onPaused;
  });
  // Spot positions and view directions, unpacked once.
  const spotData = useMemo(
    () =>
      (spots ?? []).map(([x, y, z, yaw, pitch]) => ({
        p: new THREE.Vector3(x, y, z),
        d: new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)),
      })),
    [spots],
  );
  const guard = useRef({ fade: 0, clear: true, wait: 0, paused: false });

  useEffect(() => {
    let disposed = false;
    let created: { spark: THREE.Object3D & { dispose?: () => void }; splats: THREE.Object3D & { dispose: () => void } } | null = null;
    const models = modelsRef.current;
    report.current("loading");
    (async () => {
      try {
        const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
        if (disposed) return;
        const spark = new SparkRenderer({ renderer: gl, maxStdDev: 3, preBlurAmount: 0.3 });
        const splats = new SplatMesh({ url });
        created = { spark, splats };
        await splats.initialized;
        if (disposed) return;
        spark.visible = splats.visible = false;
        scene.add(spark, splats);
        setLayer({ spark, splats });
        invalidate();
        report.current("ready");
      } catch (e) {
        if (!disposed) report.current("failed", e instanceof Error ? e.message : "The photoreal walkthrough couldn't be loaded.");
      }
    })();
    return () => {
      disposed = true;
      if (created) {
        scene.remove(created.spark, created.splats);
        created.splats.dispose();
        created.spark.dispose?.();
      }
      if (models) models.visible = true;
    };
  }, [gl, scene, url, invalidate, modelsRef]);

  /** Whether the splats can be trusted for the current view (with hysteresis: `wasClear`). */
  const viewIsClear = (wasClear: boolean) => {
    const model = modelRef.current;
    if (model) {
      const distances: number[] = [];
      raycaster.far = 8;
      for (const [x, y] of PROBES) {
        probe.set(x, y);
        raycaster.setFromCamera(probe, camera);
        const hit = raycaster.intersectObject(model, true).find((h) => !h.object.userData.noPick);
        distances.push(hit ? hit.distance : 8);
      }
      raycaster.far = Infinity;
      distances.sort((a, b) => a - b);
      const near = distances[Math.floor(distances.length / 2)];
      if (near < (wasClear ? SPLAT_NEAR_PAUSE : SPLAT_NEAR_RESUME)) return false;
    }
    if (spotData.length) {
      camera.getWorldDirection(forward);
      const range = wasClear ? SPOT_RANGE.pause : SPOT_RANGE.resume;
      const cosine = wasClear ? SPOT_ANGLE.pause : SPOT_ANGLE.resume;
      if (!spotData.some((s) => s.p.distanceTo(camera.position) < range && s.d.dot(forward) > cosine)) return false;
    }
    return true;
  };

  useFrame((_, dt) => {
    const models = modelsRef.current;
    const g = guard.current;
    if (!layer) {
      if (models) models.visible = true;
      return;
    }
    if (visible) {
      g.wait -= dt;
      if (g.wait <= 0) {
        g.wait = 0.15;
        g.clear = viewIsClear(g.clear);
      }
    }
    const target = visible && g.clear ? 1 : 0;
    // Switching photoreal on or off is immediate; pausing for a close-up fades.
    g.fade = !visible ? 0 : g.fade + Math.sign(target - g.fade) * Math.min(Math.abs(target - g.fade), Math.min(dt, 0.1) / SPLAT_FADE_SECONDS);
    layer.splats.opacity = g.fade;
    layer.splats.visible = layer.spark.visible = g.fade > 0.001;
    if (models) models.visible = g.fade < 0.999;
    const paused = visible && !g.clear;
    if (paused !== g.paused) {
      g.paused = paused;
      reportPaused.current?.(paused);
    }
  });
  return null;
}

/** The model not shown at the start (photos or clean), loaded on first switch. */
function AlternateModel({ url, visible, onReady }: { url: string; visible: boolean; onReady: (scene: THREE.Object3D) => void }) {
  const gltf = useLoader(GLTFLoader, url, configureLoader);
  useLayoutEffect(() => {
    prepareScene(gltf.scene);
    onReady(gltf.scene);
  }, [gltf, onReady]);
  return (
    <group visible={visible}>
      <Bvh firstHitOnly>
        <primitive object={gltf.scene} />
      </Bvh>
    </group>
  );
}

/**
 * Swap every material for an unlit one with the same colour texture, so a
 * photo-textured scan looks exactly as captured (its lighting is baked into
 * the texture). Returns a function that restores the original materials.
 */
function showUnlit(root: THREE.Object3D): () => void {
  const restore: (() => void)[] = [];
  const unlit = new Map<THREE.Material, THREE.Material>();
  const toUnlit = (m: THREE.Material) => {
    let basic = unlit.get(m);
    if (!basic) {
      const src = m as THREE.MeshStandardMaterial;
      basic = new THREE.MeshBasicMaterial({
        name: m.name,
        map: src.map ?? null,
        color: src.color ?? new THREE.Color("#ffffff"),
        vertexColors: m.vertexColors,
        transparent: m.transparent,
        opacity: m.opacity,
        alphaTest: m.alphaTest,
        alphaMap: src.alphaMap ?? null,
        side: m.side,
        depthWrite: m.depthWrite,
        polygonOffset: m.polygonOffset,
        polygonOffsetFactor: m.polygonOffsetFactor,
        toneMapped: false,
      });
      unlit.set(m, basic);
    }
    return basic;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const original = mesh.material;
    mesh.material = Array.isArray(original) ? original.map(toUnlit) : toUnlit(original);
    restore.push(() => (mesh.material = original));
  });
  return () => {
    restore.forEach((r) => r());
    unlit.forEach((m) => m.dispose());
  };
}

/** Procedural studio environment for soft reflections and fill (no network fetch). */
function EnvironmentLighting({ intensity }: { intensity: number }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = intensity;
    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, intensity]);
  return null;
}

class SceneErrorBoundary extends Component<{ onError: (m: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error instanceof Error ? error.message : "Could not load the 3D capture.");
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
