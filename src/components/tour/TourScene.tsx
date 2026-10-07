"use client";

/* eslint-disable react-hooks/immutability -- three.js scene objects are mutated imperatively, as is idiomatic with React Three Fiber. */

import { Bvh } from "@react-three/drei";
import { EffectComposer, N8AO, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { TourSpace, Waypoint } from "@/lib/tour/types";
import { CameraRig } from "./CameraRig";
import type { LivePose, ViewerApi, ViewerMode } from "./viewer-types";

export interface TourSceneProps {
  assetUrl: string;
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
  /** Screen-space ambient occlusion; enabled on desktop-class GPUs. */
  effects?: boolean;
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

function PropertyModel({
  assetUrl,
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
  effects = false,
}: TourSceneProps) {
  const modelRef = useRef<THREE.Group>(null);
  const gltf = useLoader(
    GLTFLoader,
    assetUrl,
    (loader) => {
      const draco = new DRACOLoader();
      draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
    },
    (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    },
  );

  // Captures may or may not ship their own lights (the demo does; RoomPlan
  // exports don't). Balance image-based lighting accordingly.
  const hasLights = useMemo(() => {
    let lights = 0;
    gltf.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) lights++;
    });
    return lights > 0;
  }, [gltf]);

  useLayoutEffect(() => {
    gltf.scene.traverse((o) => {
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
    onLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltf]);

  return (
    <>
      <EnvironmentLighting intensity={hasLights ? 0.9 : 1.15} />
      <hemisphereLight args={["#fff8ee", "#b9ab98", hasLights ? 0.5 : 0.75]} />
      <Bvh firstHitOnly>
        <primitive object={gltf.scene} ref={modelRef} />
      </Bvh>
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
      />
      {effects && (
        <EffectComposer multisampling={4}>
          <N8AO aoRadius={0.6} distanceFalloff={0.7} intensity={2.4} quality="medium" halfRes />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
      )}
    </>
  );
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
