"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { formatRoomSize, roomSize } from "@/lib/tour/measure";
import { polygonCentroid } from "@/lib/tour/navigation";
import type { TourFloor, TourRoom, Vec2 } from "@/lib/tour/types";
import type { PlanWalls } from "./plan-walls";
import type { LivePose } from "./viewer-types";

interface Props {
  floor: TourFloor;
  rooms: TourRoom[];
  /** Where the outlines are real walls (plan-walls.ts); null until the model has been checked, then no walls are drawn yet. */
  walls: PlanWalls | null;
  currentRoomId: string | null;
  poseRef: MutableRefObject<LivePose>;
  onRoomClick: (roomId: string) => void;
  className?: string;
}

/** Walls are cut away at this height (m), dollhouse style, so every room can be seen into. */
const WALL_HEIGHT = 1.6;
const WALL_THICKNESS = 0.08;
const FOV = 32;
const NO_WALLS: [Vec2, Vec2][] = [];

/**
 * The floor as a small 3D model, in place of the flat plan: each room's walls raised from its floor
 * outline (the scan's RoomPlan footprints), labelled with its name and size, the room you're in
 * highlighted, and a marker for where you are and which way you face. Drag to turn it; tap a room to go
 * there. Plan (x, z) is the model's frame, so the marker needs no conversion.
 */
export function FloorModel({ floor, rooms, walls, currentRoomId, poseRef, onRoomClick, className }: Props) {
  const plan = useMemo(() => {
    const shaped = rooms.filter((r) => r.footprint && r.footprint.length >= 3);
    const pts = shaped.flatMap((r) => r.footprint!);
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    const center: Vec2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
    const radius = Math.max(2, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2);
    return { shaped, center, radius };
  }, [rooms]);

  // Seen from the south-east, 50° down: far enough that the whole floor fits the panel.
  const distance = (plan.radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2))) * 0.78;
  const polar = THREE.MathUtils.degToRad(50);
  const azimuth = THREE.MathUtils.degToRad(35);
  const cameraPosition: [number, number, number] = [
    distance * Math.sin(polar) * Math.sin(azimuth),
    distance * Math.cos(polar),
    distance * Math.sin(polar) * Math.cos(azimuth),
  ];

  // Labels are plain buttons over the canvas, moved every frame to their room's spot on screen.
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const anchors = useMemo(
    () =>
      plan.shaped.map((r) => {
        const [x, z] = polygonCentroid(r.footprint!);
        return { id: r.id, position: new THREE.Vector3(x - plan.center[0], WALL_HEIGHT * 0.15, z - plan.center[1]) };
      }),
    [plan],
  );

  return (
    <div className={`relative overflow-hidden ${className ?? ""}`} aria-label={`${floor.name} 3D floor plan`} role="group">
      <Canvas
        key={floor.id}
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true }}
        camera={{ fov: FOV, position: cameraPosition, near: 0.1, far: distance * 4 }}
        style={{ touchAction: "none" }}
      >
        <hemisphereLight args={["#ffffff", "#9a948a", 1.6]} />
        <directionalLight position={[6, 12, 4]} intensity={1.6} />
        <group position={[-plan.center[0], 0, -plan.center[1]]}>
          {plan.shaped.map((r) => (
            <Room key={r.id} room={r} walls={walls?.[r.id] ?? NO_WALLS} active={r.id === currentRoomId} onClick={onRoomClick} />
          ))}
          <Marker floorId={floor.id} poseRef={poseRef} scale={Math.max(1, plan.radius / 5)} />
        </group>
        <LabelTracker anchors={anchors} labels={labels} />
        <OrbitControls
          makeDefault
          enablePan={false}
          minDistance={distance * 0.45}
          maxDistance={distance * 1.6}
          minPolarAngle={0.15}
          maxPolarAngle={THREE.MathUtils.degToRad(75)}
          rotateSpeed={0.7}
        />
      </Canvas>
      {plan.shaped.map((r) => {
        const active = r.id === currentRoomId;
        const size = active ? roomSize(r.footprint) : null;
        return (
          <button
            key={r.id}
            type="button"
            ref={(el) => {
              if (el) labels.current.set(r.id, el);
              else labels.current.delete(r.id);
            }}
            onClick={() => onRoomClick(r.id)}
            style={{ visibility: "hidden" }}
            className={`absolute left-0 top-0 whitespace-nowrap rounded-full px-2 py-0.5 text-center leading-tight shadow-sm ring-1 ring-black/10 transition-colors ${
              active ? "z-20 bg-[#d6b67c] text-neutral-900" : "z-10 bg-white/90 text-neutral-800 hover:bg-white"
            }`}
          >
            <span className="block text-[10px] font-semibold">{r.name}</span>
            {size && <span className="block text-[9px] tabular-nums text-neutral-700">{formatRoomSize(size)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Moves each room's label to where its anchor lands on screen (centered), every frame. */
function LabelTracker({ anchors, labels }: { anchors: { id: string; position: THREE.Vector3 }[]; labels: MutableRefObject<Map<string, HTMLButtonElement>> }) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    for (const a of anchors) {
      const el = labels.current.get(a.id);
      if (!el) continue;
      v.copy(a.position).project(camera);
      const visible = v.z < 1;
      el.style.visibility = visible ? "visible" : "hidden";
      if (visible) el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px)`;
    }
  });
  return null;
}

function Room({ room, walls: segments, active, onClick }: { room: TourRoom; walls: [Vec2, Vec2][]; active: boolean; onClick: (roomId: string) => void }) {
  const footprint = room.footprint!;
  const floorGeometry = useMemo(() => {
    // Shape (x, -z) laid down by −90° about x lands on plan (x, z).
    const shape = new THREE.Shape(footprint.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    return g;
  }, [footprint]);
  // Only where the model has a wall (plan-walls.ts): open sides and doorways stay open.
  const walls = useMemo(
    () =>
      segments.map(([a, b], i) => {
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return {
          key: i,
          length,
          position: [(a[0] + b[0]) / 2, WALL_HEIGHT / 2, (a[1] + b[1]) / 2] as [number, number, number],
          angle: -Math.atan2(b[1] - a[1], b[0] - a[0]),
        };
      }),
    [segments],
  );
  const go = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return; // a drag to turn the model, not a tap
    e.stopPropagation();
    onClick(room.id);
  };
  return (
    <group>
      <mesh geometry={floorGeometry} onClick={go} position-y={0.01}>
        <meshStandardMaterial color={active ? "#d6b67c" : "#e7e3dc"} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      {walls.map((w) => (
        <mesh key={w.key} position={w.position} rotation-y={w.angle} onClick={go}>
          <boxGeometry args={[w.length + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS]} />
          <meshStandardMaterial color="#f7f5f1" roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/** Where you are and which way you face, every frame from the live pose (no React renders). */
function Marker({ floorId, poseRef, scale }: { floorId: string; poseRef: MutableRefObject<LivePose>; scale: number }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = group.current;
    const pose = poseRef.current;
    if (!g) return;
    g.visible = pose.floorId === floorId;
    if (!g.visible) return;
    g.position.set(pose.position[0], 0.06, pose.position[2]);
    // yaw = 0 looks toward −z, + turns left: the same rotation about y turns the marker.
    g.rotation.y = pose.yaw;
  });
  return (
    <group ref={group} visible={false} scale={scale}>
      <mesh position-y={0.18}>
        <sphereGeometry args={[0.18, 24, 16]} />
        <meshStandardMaterial color="#b8955a" emissive="#d6b67c" emissiveIntensity={0.35} />
      </mesh>
      {/* The view cone: its tip at the marker, widening along −z (where the camera looks at yaw 0). */}
      <mesh position={[0, 0.04, -0.75]} rotation-x={Math.PI / 2}>
        <coneGeometry args={[0.55, 1.1, 24, 1, true]} />
        <meshBasicMaterial color="#f2d7a4" transparent opacity={0.45} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}
