"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { polygonCentroid } from "@/lib/tour/navigation";
import type { TourFloor, TourRoom, Vec2 } from "@/lib/tour/types";
import type { LivePose } from "./viewer-types";

interface Props {
  floor: TourFloor;
  rooms: TourRoom[];
  currentRoomId: string | null;
  poseRef: MutableRefObject<LivePose>;
  onRoomClick: (roomId: string) => void;
  className?: string;
}

const toPoints = (poly: Vec2[]) => poly.map(([x, z]) => `${x},${z}`).join(" ");

/**
 * Floor plan drawn directly in model space (meters): x → right, z → down.
 * Today the polygons come from the scan manifest; with RoomPlan they will be
 * generated from the captured room geometry.
 */
export function FloorPlan({ floor, rooms, currentRoomId, poseRef, onRoomClick, className }: Props) {
  const markerRef = useRef<SVGGElement>(null);

  const bounds = useMemo(() => {
    const pts: Vec2[] = [];
    if (floor.outline) pts.push(...floor.outline);
    for (const r of rooms) {
      if (r.footprint) pts.push(...r.footprint);
      pts.push([r.waypoint.position[0], r.waypoint.position[2]]);
    }
    if (!pts.length) pts.push([-5, -5], [5, 5]);
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    const pad = 0.8;
    const minX = Math.min(...xs) - pad;
    const minZ = Math.min(...zs) - pad;
    return { minX, minZ, w: Math.max(...xs) + pad - minX, h: Math.max(...zs) + pad - minZ };
  }, [floor, rooms]);

  const scale = Math.max(bounds.w, bounds.h) / 18; // keeps strokes/text proportional for small or huge plans
  const labelSize = 0.58 * scale;

  // Live position marker, updated every frame without React renders.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = markerRef.current;
      const pose = poseRef.current;
      if (g) {
        const visible = pose.floorId === floor.id;
        g.style.opacity = visible ? "1" : "0";
        if (visible) {
          const [x, , z] = pose.position;
          const angle = (Math.atan2(-Math.cos(pose.yaw), -Math.sin(pose.yaw)) * 180) / Math.PI;
          g.setAttribute("transform", `translate(${x} ${z}) rotate(${angle}) scale(${scale})`);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [floor.id, poseRef, scale]);

  return (
    <svg
      viewBox={`${bounds.minX} ${bounds.minZ} ${bounds.w} ${bounds.h}`}
      className={className}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${floor.name} floor plan`}
    >
      {floor.outline && (
        <polygon points={toPoints(floor.outline)} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.55)" strokeWidth={0.12 * scale} strokeLinejoin="round" />
      )}
      {floor.features
        .filter((f) => f.type === "void")
        .map((f, i) => (
          <g key={`void-${i}`}>
            <polygon points={toPoints(f.polygon)} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={0.04 * scale} strokeDasharray={`${0.18 * scale} ${0.14 * scale}`} />
            <text
              x={polygonCentroid(f.polygon)[0]}
              y={polygonCentroid(f.polygon)[1] + 1.2}
              fontSize={labelSize * 0.8}
              textAnchor="middle"
              fill="rgba(255,255,255,0.45)"
              fontStyle="italic"
            >
              {f.label ?? "Open to below"}
            </text>
          </g>
        ))}
      {rooms.map((r) => {
        const active = r.id === currentRoomId;
        if (!r.footprint || r.footprint.length < 3) return null;
        return (
          <polygon
            key={r.id}
            points={toPoints(r.footprint)}
            className="cursor-pointer transition-[fill] duration-300"
            fill={active ? "rgba(214,182,124,0.38)" : "rgba(255,255,255,0.07)"}
            stroke="rgba(255,255,255,0.7)"
            strokeWidth={0.06 * scale}
            onClick={() => onRoomClick(r.id)}
          >
            <title>{r.name}</title>
          </polygon>
        );
      })}
      {floor.features
        .filter((f) => f.type === "stairs")
        .map((f, i) => {
          const xs = f.polygon.map((p) => p[0]);
          const zs = f.polygon.map((p) => p[1]);
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          const z0 = Math.min(...zs);
          const z1 = Math.max(...zs);
          const n = Math.min(f.treads ?? 12, 24);
          const vertical = z1 - z0 > x1 - x0;
          return (
            <g key={`stairs-${i}`} pointerEvents="none">
              <rect x={x0} y={z0} width={x1 - x0} height={z1 - z0} fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.55)" strokeWidth={0.04 * scale} />
              {Array.from({ length: n - 1 }, (_, k) => {
                const t = (k + 1) / n;
                return vertical ? (
                  <line key={k} x1={x0} x2={x1} y1={z0 + (z1 - z0) * t} y2={z0 + (z1 - z0) * t} stroke="rgba(255,255,255,0.35)" strokeWidth={0.025 * scale} />
                ) : (
                  <line key={k} y1={z0} y2={z1} x1={x0 + (x1 - x0) * t} x2={x0 + (x1 - x0) * t} stroke="rgba(255,255,255,0.35)" strokeWidth={0.025 * scale} />
                );
              })}
            </g>
          );
        })}
      {rooms.map((r) => {
        const c: Vec2 = r.footprint && r.footprint.length >= 3 ? polygonCentroid(r.footprint) : [r.waypoint.position[0], r.waypoint.position[2]];
        const active = r.id === currentRoomId;
        const hasFootprint = !!r.footprint && r.footprint.length >= 3;
        return (
          <g key={`label-${r.id}`} className="cursor-pointer" onClick={() => onRoomClick(r.id)}>
            {!hasFootprint && <circle cx={c[0]} cy={c[1] - labelSize * 1.1} r={0.22 * scale} fill={active ? "#d6b67c" : "rgba(255,255,255,0.8)"} />}
            <text
              x={c[0]}
              y={c[1] + labelSize * 0.35}
              fontSize={labelSize}
              textAnchor="middle"
              fill={active ? "#f6e7c8" : "rgba(255,255,255,0.82)"}
              fontWeight={active ? 600 : 500}
              style={{ letterSpacing: "0.02em" }}
            >
              {r.name}
            </text>
          </g>
        );
      })}
      <g ref={markerRef} style={{ opacity: 0, transition: "opacity 300ms" }} pointerEvents="none">
        <path d="M0 0 L2.2 -1.25 A2.55 2.55 0 0 1 2.2 1.25 Z" fill="url(#fp-cone)" />
        <circle r={0.34} fill="#d6b67c" stroke="#fff" strokeWidth={0.1} />
      </g>
      <defs>
        <radialGradient id="fp-cone" cx="0" cy="0" r="2.6" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#f2d7a4" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#f2d7a4" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  );
}
