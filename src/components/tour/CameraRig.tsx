"use client";

/* eslint-disable react-hooks/immutability, react-hooks/refs -- the camera rig drives three.js objects imperatively from the render loop, as is idiomatic with React Three Fiber. */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import * as THREE from "three";
import { findRoute, floorForHeight, nearestRoom, pointInPolygon, roomAt } from "@/lib/tour/navigation";
import type { TourSpace, Vec3, Waypoint } from "@/lib/tour/types";
import type { LivePose, ViewerApi, ViewerMode } from "./viewer-types";

interface Props {
  space: TourSpace;
  modelRef: RefObject<THREE.Object3D | null>;
  apiRef: MutableRefObject<ViewerApi | null>;
  poseRef: MutableRefObject<LivePose>;
  startWaypoint: Waypoint;
  /** Becomes true when the visitor enters the tour; triggers the intro move. */
  active: boolean;
  mode: ViewerMode;
  onRoomChange: (roomId: string | null) => void;
  onMovingChange: (moving: boolean) => void;
  onFade: (visible: boolean) => void;
}

interface Motion {
  curve: THREE.Curve<THREE.Vector3> | null;
  duration: number;
  elapsed: number;
  yaw0: number;
  pitch0: number;
  yaw1: number;
  pitch1: number;
  fov0: number;
  travelFacing: boolean;
}

const BASE_FOV = 68;
/** Keep at least ~54° of horizontal view on portrait phones (vertical FOV grows instead). */
function baseFovFor(aspect: number) {
  if (!(aspect > 0) || aspect >= 1) return BASE_FOV;
  const v = (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(54) / 2) / aspect) * 180) / Math.PI;
  return THREE.MathUtils.clamp(v, BASE_FOV, 96);
}
const LOOK_SPEED = 0.0042;
const WALK_SPEED = 1.5;
const TURN_SPEED = 1.7;

const tmpV = new THREE.Vector3();
const ndc = new THREE.Vector2();
const normalMatrix = new THREE.Matrix3();

function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function mixAngle(a: number, b: number, t: number) {
  return a + wrapAngle(b - a) * t;
}
function smoothstep(a: number, b: number, v: number) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
/** Trapezoidal velocity profile → natural "walk" acceleration and settle. */
function travelProgress(t: number, ramp: number) {
  const r = Math.min(0.45, Math.max(0.05, ramp));
  if (t < r) return (t * t) / (2 * r) / (1 - r);
  if (t > 1 - r) return 1 - ((1 - t) * (1 - t)) / (2 * r) / (1 - r);
  return (t - r / 2) / (1 - r);
}

export function CameraRig({ space, modelRef, apiRef, poseRef, startWaypoint, active, mode, onRoomChange, onMovingChange, onFade }: Props) {
  const { camera, gl, raycaster, scene, size } = useThree();
  const baseFov = baseFovFor(size.width / size.height);
  const baseFovRef = useRef(baseFov);
  baseFovRef.current = baseFov;
  const cam = camera as THREE.PerspectiveCamera;
  const cursorRef = useRef<THREE.Group>(null);

  const s = useRef({
    yaw: startWaypoint.yaw + 0.55,
    pitch: startWaypoint.pitch,
    yawTarget: startWaypoint.yaw + 0.55,
    pitchTarget: startWaypoint.pitch,
    fovTarget: baseFov + 6,
    motion: null as Motion | null,
    fade: null as null | { phase: "out" | "in"; t: number; target: Waypoint },
    pointers: new Map<number, { x: number; y: number }>(),
    downAt: { x: 0, y: 0, time: 0, moved: 0 },
    pinchDist: 0,
    hover: null as null | { x: number; y: number },
    keys: new Set<string>(),
    roomId: null as string | null,
    roomCheck: 0,
    started: false,
  });

  const latest = useRef({ onRoomChange, onMovingChange, onFade, space, mode });
  latest.current = { onRoomChange, onMovingChange, onFade, space, mode };

  // Initial placement (before the visitor enters, the camera slowly drifts).
  useEffect(() => {
    camera.position.set(...startWaypoint.position);
    camera.rotation.order = "YXZ";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roomsById = useMemo(() => new Map(space.rooms.map((r) => [r.id, r])), [space]);

  // Re-frame when the viewport changes shape (e.g. a phone rotates).
  useEffect(() => {
    if (s.current.started) s.current.fovTarget = baseFov;
  }, [baseFov]);

  // --- Movement primitives -------------------------------------------------

  const glideTo = (points: Vec3[], yaw1: number, pitch1: number, opts: { travelFacing?: boolean; speed?: number } = {}) => {
    const st = s.current;
    const start = camera.position.clone();
    const pts = [start, ...points.map((p) => new THREE.Vector3(...p))].filter(
      (p, i, arr) => i === 0 || p.distanceTo(arr[i - 1]) > 0.05,
    );
    let curve: THREE.Curve<THREE.Vector3> | null = null;
    let length = 0;
    if (pts.length === 2) {
      curve = new THREE.LineCurve3(pts[0], pts[1]);
      length = pts[0].distanceTo(pts[1]);
    } else if (pts.length > 2) {
      const c = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.5);
      curve = c;
      length = c.getLength();
    }
    const turn = Math.abs(wrapAngle(yaw1 - st.yaw));
    const duration = Math.min(7.5, Math.max(0.9, length / (opts.speed ?? 2.4) + turn * 0.25));
    st.motion = {
      curve,
      duration,
      elapsed: 0,
      yaw0: st.yaw,
      pitch0: st.pitch,
      yaw1,
      pitch1,
      fov0: cam.fov,
      travelFacing: (opts.travelFacing ?? true) && length > 2.2,
    };
    latest.current.onMovingChange(true);
  };

  const fadeTo = (target: Waypoint) => {
    s.current.motion = null;
    s.current.fade = { phase: "out", t: 0, target };
    latest.current.onFade(true);
    latest.current.onMovingChange(true);
  };

  const goToRoom = (roomId: string) => {
    const st = s.current;
    const room = roomsById.get(roomId);
    if (!room) return;
    const { space: sp } = latest.current;
    const from = st.roomId ?? roomAt(sp, camera.position.toArray() as Vec3)?.id ?? nearestRoom(sp, camera.position.toArray() as Vec3)?.id;
    const wp = room.waypoint;
    if (!from) return fadeTo(wp);
    if (from === roomId) return glideTo([wp.position], wp.yaw, wp.pitch, { travelFacing: false });
    const route = findRoute(sp, from, roomId);
    if (!route) return fadeTo(wp);
    glideTo(route.points, wp.yaw, wp.pitch, { speed: route.usesStairs ? 2.6 : 2.4 });
  };

  // --- Imperative API ------------------------------------------------------

  useEffect(() => {
    apiRef.current = {
      goToRoom,
      getPose: () => ({
        position: camera.position.toArray().map((v) => Math.round(v * 1000) / 1000) as Vec3,
        yaw: Math.round(wrapAngle(s.current.yaw) * 1000) / 1000,
        pitch: Math.round(s.current.pitch * 1000) / 1000,
      }),
      setPose: (pose, instant) => {
        if (instant) {
          camera.position.set(...pose.position);
          Object.assign(s.current, { yaw: pose.yaw, yawTarget: pose.yaw, pitch: pose.pitch, pitchTarget: pose.pitch, motion: null });
        } else {
          glideTo([pose.position], pose.yaw, pose.pitch, { travelFacing: false });
        }
      },
      captureFrame: (width = 1280) => {
        // Render synchronously so the drawing buffer is valid without preserveDrawingBuffer.
        gl.render(scene, camera);
        const src = gl.domElement;
        const c = document.createElement("canvas");
        const ratio = src.height / src.width;
        c.width = width;
        c.height = Math.round(width * Math.min(ratio, 0.75));
        const ctx = c.getContext("2d");
        if (!ctx) return null;
        const sh = (src.width * c.height) / c.width;
        ctx.drawImage(src, 0, (src.height - sh) / 2, src.width, sh, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", 0.86);
      },
      lineOfSight: (a, b) => {
        const model = modelRef.current;
        if (!model) return false;
        const from = new THREE.Vector3(...a);
        const dir = new THREE.Vector3(...b).sub(from);
        const len = dir.length();
        if (len < 1e-3) return true;
        raycaster.set(from, dir.normalize());
        raycaster.far = len;
        const hits = raycaster.intersectObject(model, true).filter((h) => !h.object.userData.noPick);
        raycaster.far = Infinity;
        return hits.length === 0;
      },
      snapToFloor: () => {
        const model = modelRef.current;
        if (!model) return false;
        raycaster.set(camera.position, new THREE.Vector3(0, -1, 0));
        raycaster.far = 6;
        const hit = raycaster.intersectObject(model, true).find((h) => !h.object.userData.noPick);
        raycaster.far = Infinity;
        if (!hit) return false;
        camera.position.y = hit.point.y + latest.current.space.eyeHeight;
        return true;
      },
    };
    return () => {
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsById]);

  // Captures without rooms yet (fresh uploads): start at the model's center, standing on its lowest floor.
  useEffect(() => {
    if (space.rooms.length || !modelRef.current) return;
    const box = new THREE.Box3().setFromObject(modelRef.current);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    camera.position.set(c.x, box.min.y + space.eyeHeight, c.z);
    Object.assign(s.current, { yaw: 0, yawTarget: 0, pitch: 0, pitchTarget: 0, started: true });
    // The model is mounted in the same commit, before this effect runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Intro: a gentle settling pan when the visitor enters.
  useEffect(() => {
    if (!active || s.current.started) return;
    s.current.started = true;
    glideTo([startWaypoint.position], startWaypoint.yaw, startWaypoint.pitch, { travelFacing: false });
    if (s.current.motion) s.current.motion.duration = 2.6;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // --- Floor picking -------------------------------------------------------

  const pickFloor = (clientX: number, clientY: number): THREE.Vector3 | null => {
    const model = modelRef.current;
    if (!model) return null;
    const rect = gl.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    raycaster.far = 30;
    const hits = raycaster.intersectObject(model, true);
    const hit = hits.find((h) => (h.object as THREE.Mesh).isMesh && !(h.object.userData.noPick));
    if (!hit || !hit.face) return null;
    normalMatrix.getNormalMatrix(hit.object.matrixWorld);
    const n = tmpV.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();
    if (n.y < 0.85) return null;
    const sp = latest.current.space;
    const floor = floorForHeight(sp, camera.position.y);
    if (floor && Math.abs(hit.point.y - floor.elevation) > 0.3) return null;
    if (!isWalkable(hit.point.x, hit.point.z, floor?.id ?? null, 0)) return null;
    return hit.point.clone();
  };

  const isWalkable = (x: number, z: number, floorId: string | null, margin: number) => {
    const sp = latest.current.space;
    const rooms = sp.rooms.filter((r) => (floorId ? r.floorId === floorId : true) && r.footprint && r.footprint.length >= 3);
    if (!rooms.length) {
      const model = modelRef.current;
      if (!model) return true;
      const box = new THREE.Box3().setFromObject(model);
      return x > box.min.x && x < box.max.x && z > box.min.z && z < box.max.z;
    }
    const probes: [number, number][] = margin
      ? [
          [x + margin, z],
          [x - margin, z],
          [x, z + margin],
          [x, z - margin],
        ]
      : [[x, z]];
    return probes.every(([px, pz]) => rooms.some((r) => pointInPolygon(px, pz, r.footprint!)));
  };

  // --- Input ---------------------------------------------------------------

  useEffect(() => {
    const el = gl.domElement;
    const st = s.current;

    const onDown = (e: PointerEvent) => {
      if (!st.started) return;
      el.setPointerCapture(e.pointerId);
      st.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (st.pointers.size === 1) st.downAt = { x: e.clientX, y: e.clientY, time: performance.now(), moved: 0 };
      if (st.pointers.size === 2) {
        const [a, b] = [...st.pointers.values()];
        st.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      const p = st.pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === "mouse") st.hover = { x: e.clientX, y: e.clientY };
        return;
      }
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (st.pointers.size === 2) {
        const [a, b] = [...st.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (st.pinchDist > 0) st.fovTarget = THREE.MathUtils.clamp(st.fovTarget * (st.pinchDist / d), 35, Math.max(85, baseFovRef.current));
        st.pinchDist = d;
        st.downAt.moved += 100;
        return;
      }
      st.downAt.moved += Math.abs(dx) + Math.abs(dy);
      if (st.motion) return;
      const k = LOOK_SPEED * (cam.fov / baseFovRef.current) * (e.pointerType === "touch" ? 1.25 : 1);
      st.yawTarget += dx * k;
      st.pitchTarget = THREE.MathUtils.clamp(st.pitchTarget + dy * k, -1.25, 1.25);
      st.hover = null;
    };
    const onUp = (e: PointerEvent) => {
      if (!st.pointers.has(e.pointerId)) return;
      st.pointers.delete(e.pointerId);
      el.style.cursor = "";
      const quick = performance.now() - st.downAt.time < 450;
      if (st.pointers.size === 0 && quick && st.downAt.moved < 8 && !st.motion) {
        const target = pickFloor(e.clientX, e.clientY);
        if (target) {
          const sp = latest.current.space;
          const eye = target.y + sp.eyeHeight;
          // Stop a little short of the clicked point so we never end up in a wall.
          const dir = new THREE.Vector3(target.x - camera.position.x, 0, target.z - camera.position.z);
          const d = dir.length();
          if (d > 0.9) target.addScaledVector(dir.normalize(), -0.35);
          glideTo([[target.x, eye, target.z]], st.yawTarget, THREE.MathUtils.clamp(st.pitchTarget, -0.35, 0.35), {
            travelFacing: false,
            speed: 2.2,
          });
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!st.started) return;
      e.preventDefault();
      st.fovTarget = THREE.MathUtils.clamp(st.fovTarget + e.deltaY * 0.03, 35, Math.max(85, baseFovRef.current));
    };
    const onLeave = () => {
      st.hover = null;
    };
    const isTyping = () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping() || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", "q", "e", "r", "f", "shift"].includes(k)) {
        st.keys.add(k);
        if (k.startsWith("arrow")) e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => st.keys.delete(e.key.toLowerCase());
    const onBlur = () => st.keys.clear();

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera]);

  // --- Frame loop ----------------------------------------------------------

  useFrame((_, rawDt) => {
    // Generous cap so slow devices still finish moves on time, small enough to avoid jumps after tab switches.
    const dt = Math.min(rawDt, 0.12);
    const st = s.current;
    const sp = latest.current.space;

    if (st.fade) {
      st.fade.t += dt;
      if (st.fade.phase === "out" && st.fade.t > 0.38) {
        const w = st.fade.target;
        camera.position.set(...w.position);
        Object.assign(st, { yaw: w.yaw, yawTarget: w.yaw, pitch: w.pitch, pitchTarget: w.pitch });
        st.fade = { phase: "in", t: 0, target: w };
        latest.current.onFade(false);
      } else if (st.fade.phase === "in" && st.fade.t > 0.45) {
        st.fade = null;
        latest.current.onMovingChange(false);
      }
    } else if (st.motion) {
      const m = st.motion;
      m.elapsed += dt;
      const t = Math.min(1, m.elapsed / m.duration);
      const u = travelProgress(t, Math.min(0.42, 0.85 / m.duration));
      if (m.curve) camera.position.copy(m.curve.getPointAt(Math.min(1, Math.max(0, u))));
      let yaw: number;
      let pitch: number;
      if (m.travelFacing && m.curve) {
        const tan = m.curve.getTangentAt(Math.min(0.999, Math.max(0.001, u)));
        const tyaw = Math.atan2(-tan.x, -tan.z);
        const tpitch = Math.atan2(tan.y, Math.hypot(tan.x, tan.z)) * 0.55;
        const a = smoothstep(0, 0.22, t);
        const b = smoothstep(0.6, 1, t);
        yaw = mixAngle(mixAngle(m.yaw0, tyaw, a), m.yaw1, b);
        pitch = THREE.MathUtils.lerp(THREE.MathUtils.lerp(m.pitch0, tpitch, a), m.pitch1, b);
      } else {
        const b = smoothstep(0, 1, t);
        yaw = mixAngle(m.yaw0, m.yaw1, b);
        pitch = THREE.MathUtils.lerp(m.pitch0, m.pitch1, b);
      }
      st.yaw = st.yawTarget = yaw;
      st.pitch = st.pitchTarget = pitch;
      if (!st.started || t >= 1) st.fovTarget = baseFovRef.current;
      if (t >= 1) {
        st.motion = null;
        latest.current.onMovingChange(false);
      }
    } else {
      // Keyboard look + walk.
      const k = st.keys;
      if (st.started && k.size) {
        if (k.has("arrowleft") || k.has("a") || k.has("q")) st.yawTarget += TURN_SPEED * dt;
        if (k.has("arrowright") || k.has("d") || k.has("e")) st.yawTarget -= TURN_SPEED * dt;
        if (k.has("r")) st.pitchTarget = Math.min(1.2, st.pitchTarget + dt);
        if (k.has("f")) st.pitchTarget = Math.max(-1.2, st.pitchTarget - dt);
        const fwd = (k.has("arrowup") || k.has("w") ? 1 : 0) - (k.has("arrowdown") || k.has("s") ? 1 : 0);
        if (fwd) {
          const speed = WALK_SPEED * (k.has("shift") ? 3 : 1);
          const dx = -Math.sin(st.yaw) * fwd * speed * dt;
          const dz = -Math.cos(st.yaw) * fwd * speed * dt;
          if (latest.current.mode === "edit") {
            // Free-fly for authoring viewpoints: move along the view direction.
            const vy = Math.sin(st.pitch) * fwd * speed * dt;
            camera.position.add(tmpV.set(dx * Math.cos(st.pitch), vy, dz * Math.cos(st.pitch)));
          } else {
            const floor = floorForHeight(sp, camera.position.y);
            const nx = camera.position.x + dx;
            const nz = camera.position.z + dz;
            if (isWalkable(nx, nz, floor?.id ?? null, 0.3)) camera.position.set(nx, camera.position.y, nz);
            else if (isWalkable(nx, camera.position.z, floor?.id ?? null, 0.3)) camera.position.x = nx;
            else if (isWalkable(camera.position.x, nz, floor?.id ?? null, 0.3)) camera.position.z = nz;
          }
        }
      }
      if (!st.started) st.yawTarget -= dt * 0.02;
      const damp = 1 - Math.exp(-dt * 11);
      st.yaw += wrapAngle(st.yawTarget - st.yaw) * damp;
      st.pitch += (st.pitchTarget - st.pitch) * damp;
    }

    camera.rotation.set(st.pitch, st.yaw, 0, "YXZ");
    if (Math.abs(cam.fov - st.fovTarget) > 0.01) {
      cam.fov += (st.fovTarget - cam.fov) * (1 - Math.exp(-dt * (st.motion ? 2.2 : 8)));
      cam.updateProjectionMatrix();
    }

    // Hover cursor on walkable floor (desktop).
    const cursor = cursorRef.current;
    if (cursor) {
      const hit = st.hover && !st.motion && st.started && st.pointers.size === 0 ? pickFloor(st.hover.x, st.hover.y) : null;
      cursor.visible = !!hit;
      if (hit) cursor.position.set(hit.x, hit.y + 0.01, hit.z);
      gl.domElement.style.cursor = hit ? "pointer" : st.pointers.size ? "grabbing" : "grab";
    }

    // Live pose + room detection.
    const pose = poseRef.current;
    pose.position = [camera.position.x, camera.position.y, camera.position.z];
    pose.yaw = st.yaw;
    st.roomCheck -= dt;
    if (st.roomCheck <= 0) {
      st.roomCheck = 0.12;
      const posArr = pose.position;
      const floor = floorForHeight(sp, posArr[1]);
      pose.floorId = floor?.id ?? null;
      const hasFootprints = sp.rooms.some((r) => r.footprint && r.footprint.length >= 3);
      const room = hasFootprints ? roomAt(sp, posArr) : nearestRoom(sp, posArr);
      if (room && room.id !== st.roomId) {
        st.roomId = room.id;
        latest.current.onRoomChange(room.id);
      }
    }
  });

  return (
    <group ref={cursorRef} visible={false}>
      <mesh rotation-x={-Math.PI / 2} renderOrder={10}>
        <ringGeometry args={[0.2, 0.25, 48]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.85} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} renderOrder={10}>
        <circleGeometry args={[0.2, 48]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.18} depthWrite={false} />
      </mesh>
    </group>
  );
}
