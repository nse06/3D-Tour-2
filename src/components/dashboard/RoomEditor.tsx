"use client";

import { ArrowDown, ArrowUp, Camera, Crosshair, Eye, ImagePlus, Layers, Loader2, Plus, Save, Trash2 } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { saveSpaceAction, setAppearanceAction, setCoverImageAction } from "@/app/dashboard/actions";
import { FloorPlan } from "@/components/tour/FloorPlan";
import type { LivePose, ViewerApi } from "@/components/tour/viewer-types";
import { Button, buttonClass } from "@/components/ui";
import { floorForHeight, sortedFloors } from "@/lib/tour/navigation";
import { newId } from "@/lib/tour/space";
import type { SplatSpot, TourAppearance, TourFloor, TourRoom, TourSpace, Waypoint } from "@/lib/tour/types";
import { dataUrlToBlob, uploadFile } from "@/lib/upload-client";

const TourScene = dynamic(() => import("@/components/tour/TourScene"), { ssr: false });

interface Props {
  propertyId: string;
  assetUrl: string;
  /** Photo scans: the clean model of the same rooms (buyers can turn the photos off). */
  cleanAssetUrl?: string | null;
  /** Photoreal splats trained on the scan's photos (docs/photoreal.md). */
  splatUrl?: string | null;
  /** Where those photos were taken (photoreal shows near them). */
  splatSpots?: SplatSpot[] | null;
  initialSpace: TourSpace;
  initialAppearance: TourAppearance;
}

/**
 * Define floors and rooms for a capture: walk the model, then drop a viewpoint
 * in each room. (With iPhone scans this happens automatically; this editor is
 * for manual uploads and for fine-tuning.)
 */
export function RoomEditor({ propertyId, assetUrl, cleanAssetUrl = null, splatUrl = null, splatSpots = null, initialSpace, initialAppearance }: Props) {
  const router = useRouter();
  const apiRef = useRef<ViewerApi | null>(null);
  const [space, setSpace] = useState<TourSpace>(initialSpace);
  const floors = useMemo(() => sortedFloors(space), [space]);
  const firstRoom = useMemo(() => [...initialSpace.rooms].sort((a, b) => a.order - b.order)[0], [initialSpace]);
  const start: Waypoint = firstRoom?.waypoint ?? { position: [0, initialSpace.eyeHeight, 0], yaw: 0, pitch: 0 };
  const poseRef = useRef<LivePose>({ position: start.position, yaw: start.yaw, floorId: firstRoom?.floorId ?? null });
  const [loaded, setLoaded] = useState(false);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(firstRoom?.id ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [planFloorId, setPlanFloorId] = useState<string | null>(floors[0]?.id ?? null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [appearance, setAppearance] = useState<TourAppearance>(initialAppearance);

  const update = useCallback((fn: (s: TourSpace) => TourSpace) => {
    setSpace((s) => fn(s));
    setDirty(true);
    setMessage(null);
  }, []);

  const flash = (tone: "ok" | "error", text: string) => {
    setMessage({ tone, text });
    if (tone === "ok") setTimeout(() => setMessage((m) => (m?.text === text ? null : m)), 2600);
  };

  const floorOfCamera = (): TourFloor | null => {
    const pose = apiRef.current?.getPose();
    return (pose && floorForHeight(space, pose.position[1])) || floors[0] || null;
  };

  const addRoom = () => {
    const api = apiRef.current;
    if (!api) return;
    api.snapToFloor();
    const pose = api.getPose();
    const floor = floorOfCamera();
    if (!floor) return;
    const onFloor = space.rooms.filter((r) => r.floorId === floor.id);
    const room: TourRoom = {
      id: newId(),
      floorId: floor.id,
      name: `Room ${space.rooms.length + 1}`,
      order: onFloor.length ? Math.max(...onFloor.map((r) => r.order)) + 1 : 0,
      waypoint: pose,
      footprint: null,
    };
    update((s) => ({ ...s, rooms: [...s.rooms, room] }));
    setCurrentRoomId(room.id);
    requestAnimationFrame(() => document.getElementById(`room-${room.id}`)?.focus());
  };

  const addFloor = () => {
    const pose = apiRef.current?.getPose();
    const level = floors.length ? Math.max(...floors.map((f) => f.level)) + 1 : 1;
    const elevation = pose ? Math.round((pose.position[1] - space.eyeHeight) * 100) / 100 : 0;
    const floor: TourFloor = {
      id: newId(),
      name: level === 1 ? "Main Level" : level === 2 ? "Upper Level" : `Level ${level}`,
      level,
      elevation,
      outline: null,
      features: [],
    };
    update((s) => ({ ...s, floors: [...s.floors, floor] }));
    setPlanFloorId(floor.id);
  };

  const patchRoom = (id: string, patch: Partial<TourRoom>) => update((s) => ({ ...s, rooms: s.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  const patchFloor = (id: string, patch: Partial<TourFloor>) => update((s) => ({ ...s, floors: s.floors.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));

  const moveRoom = (room: TourRoom, dir: -1 | 1) => {
    const list = space.rooms.filter((r) => r.floorId === room.floorId).sort((a, b) => a.order - b.order);
    const i = list.findIndex((r) => r.id === room.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const order = new Map(list.map((r, k) => [r.id, k]));
    update((s) => ({ ...s, rooms: s.rooms.map((r) => (order.has(r.id) ? { ...r, order: order.get(r.id)! } : r)) }));
  };

  const deleteRoom = (room: TourRoom) =>
    update((s) => ({ ...s, rooms: s.rooms.filter((r) => r.id !== room.id), links: s.links.filter((l) => l.from !== room.id && l.to !== room.id) }));

  const deleteFloor = (floor: TourFloor) => {
    const rooms = space.rooms.filter((r) => r.floorId === floor.id);
    if (floors.length <= 1) return flash("error", "A tour needs at least one floor.");
    if (rooms.length && !confirm(`Delete ${floor.name} and its ${rooms.length} room(s)?`)) return;
    const ids = new Set(rooms.map((r) => r.id));
    update((s) => ({
      ...s,
      floors: s.floors.filter((f) => f.id !== floor.id),
      rooms: s.rooms.filter((r) => r.floorId !== floor.id),
      links: s.links.filter((l) => !ids.has(l.from) && !ids.has(l.to)),
    }));
  };

  /** Rooms that can see each other get a direct link so the viewer glides instead of fading. */
  const withAutoLinks = (s: TourSpace): TourSpace => {
    const api = apiRef.current;
    if (!api) return s;
    const linked = new Set(s.links.flatMap((l) => [`${l.from}|${l.to}`, `${l.to}|${l.from}`]));
    const links = [...s.links];
    for (let i = 0; i < s.rooms.length; i++) {
      for (let j = i + 1; j < s.rooms.length; j++) {
        const a = s.rooms[i];
        const b = s.rooms[j];
        if (a.floorId !== b.floorId || linked.has(`${a.id}|${b.id}`)) continue;
        if (api.lineOfSight(a.waypoint.position, b.waypoint.position)) links.push({ from: a.id, to: b.id, via: [] });
      }
    }
    return { ...s, links };
  };

  const save = async () => {
    setSaving(true);
    const res = await saveSpaceAction(propertyId, withAutoLinks(space));
    setSaving(false);
    if (!res.ok) return flash("error", res.error ?? "Could not save.");
    setDirty(false);
    flash("ok", "Rooms saved");
    router.refresh();
  };

  const setCover = async () => {
    const api = apiRef.current;
    const frame = api?.captureFrame(1600);
    if (!frame) return;
    setCoverBusy(true);
    try {
      const url = await uploadFile(propertyId, "cover", dataUrlToBlob(frame), "cover.jpg");
      const res = await setCoverImageAction(propertyId, url);
      if (!res.ok) throw new Error(res.error);
      flash("ok", "Cover photo updated");
      router.refresh();
    } catch (e) {
      flash("error", (e as Error).message);
    } finally {
      setCoverBusy(false);
    }
  };

  const planFloor = floors.find((f) => f.id === planFloorId) ?? floors[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <aside className="order-2 space-y-4 lg:order-1">
        <div className="rounded-3xl border border-sand bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-stone">Floors & rooms</p>
            <button
              onClick={addFloor}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-black/5"
            >
              <Plus className="size-3.5" /> Floor
            </button>
          </div>
          <div className="mt-3 space-y-5">
            {floors.map((f) => {
              const rooms = space.rooms.filter((r) => r.floorId === f.id).sort((a, b) => a.order - b.order);
              return (
                <div key={f.id}>
                  <div className="flex items-center gap-2">
                    <Layers className="size-4 shrink-0 text-gold" />
                    <input
                      value={f.name}
                      onChange={(e) => patchFloor(f.id, { name: e.target.value })}
                      className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold outline-none hover:border-sand focus:border-neutral-400"
                    />
                    <label className="flex items-center gap-1 text-[11px] text-neutral-400" title="Floor height in the model (meters)">
                      h
                      <input
                        type="number"
                        step="0.1"
                        value={f.elevation}
                        onChange={(e) => patchFloor(f.id, { elevation: Number(e.target.value) || 0 })}
                        className="w-14 rounded-md border border-sand px-1.5 py-0.5 text-xs text-neutral-700"
                      />
                    </label>
                    <button
                      onClick={() => deleteFloor(f)}
                      className="rounded-full p-1 text-neutral-400 hover:bg-red-50 hover:text-red-600"
                      aria-label={`Delete ${f.name}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {rooms.length === 0 && <li className="rounded-xl bg-paper px-3 py-2.5 text-xs text-neutral-500">No rooms on this floor yet.</li>}
                    {rooms.map((r, i) => (
                      <li
                        key={r.id}
                        className={`group flex items-center gap-1 rounded-xl px-2 py-1.5 ${r.id === currentRoomId ? "bg-linen" : "hover:bg-paper"}`}
                      >
                        <button
                          onClick={() => {
                            apiRef.current?.setPose(r.waypoint);
                            setCurrentRoomId(r.id);
                          }}
                          className="grid size-7 shrink-0 place-items-center rounded-full text-neutral-500 hover:bg-white hover:text-ink"
                          title="Go to this viewpoint"
                        >
                          <Eye className="size-3.5" />
                        </button>
                        <input
                          id={`room-${r.id}`}
                          value={r.name}
                          onChange={(e) => patchRoom(r.id, { name: e.target.value })}
                          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1.5 py-1 text-sm outline-none hover:border-sand focus:border-neutral-400 focus:bg-white"
                        />
                        <div className="flex items-center opacity-60 transition group-hover:opacity-100">
                          <IconBtn label="Use current view" onClick={() => apiRef.current && patchRoom(r.id, { waypoint: apiRef.current.getPose() })}>
                            <Crosshair className="size-3.5" />
                          </IconBtn>
                          <IconBtn label="Move up" onClick={() => moveRoom(r, -1)} disabled={i === 0}>
                            <ArrowUp className="size-3.5" />
                          </IconBtn>
                          <IconBtn label="Move down" onClick={() => moveRoom(r, 1)} disabled={i === rooms.length - 1}>
                            <ArrowDown className="size-3.5" />
                          </IconBtn>
                          <IconBtn label="Delete room" onClick={() => deleteRoom(r)} danger>
                            <Trash2 className="size-3.5" />
                          </IconBtn>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <Button onClick={addRoom} disabled={!loaded} className="mt-5 w-full">
            <Plus className="size-4" /> Add room at current view
          </Button>
          <p className="mt-2 text-center text-[11px] text-neutral-400">Rooms are assigned to the floor you&apos;re standing on.</p>
        </div>

        <div className="rounded-3xl border border-sand bg-white p-5 text-sm text-neutral-600 shadow-sm">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-stone">How to walk the model</p>
          <ul className="mt-3 space-y-1.5">
            <li>
              <b className="font-medium text-ink">Drag</b> to look around
            </li>
            <li>
              <b className="font-medium text-ink">W A S D</b> or arrows to fly · <b className="font-medium text-ink">Shift</b> for speed
            </li>
            <li>
              <b className="font-medium text-ink">Click the floor</b> to step there
            </li>
            <li>
              <Crosshair className="inline size-3.5" /> updates a room&apos;s viewpoint to what you see now
            </li>
          </ul>
        </div>
      </aside>

      <section className="order-1 lg:order-2">
        <div className="sticky top-24">
          <div className="relative h-[62vh] min-h-[420px] overflow-hidden rounded-3xl bg-[#1a1816] shadow-lg">
            <TourScene
              assetUrl={assetUrl}
              space={space}
              startWaypoint={start}
              apiRef={apiRef}
              poseRef={poseRef}
              active
              mode="edit"
              onRoomChange={setCurrentRoomId}
              onMovingChange={() => {}}
              onFade={() => {}}
              onProgress={() => {}}
              onLoaded={() => setLoaded(true)}
              onError={(m) => flash("error", m)}
              appearance={appearance}
              cleanAssetUrl={cleanAssetUrl}
              photos={appearance !== "studio"}
              splatUrl={splatUrl}
              splatSpots={splatSpots}
              photoreal={appearance === "photoreal"}
              onSwitchError={(m) => flash("error", `That view couldn't be loaded: ${m}`)}
              effects
            />
            {!loaded && (
              <div className="absolute inset-0 grid place-items-center text-sm text-white/70">
                <span className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" /> Loading capture…
                </span>
              </div>
            )}
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <span className="size-6 rounded-full border border-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.25)]" />
            </div>
            <div className="glass absolute left-4 top-4 rounded-full px-3 py-1.5 text-xs font-medium text-white">Editing viewpoints</div>
            <div
              className="glass absolute right-4 top-4 flex rounded-full p-1 text-xs font-medium"
              role="radiogroup"
              aria-label={cleanAssetUrl ? "What buyers see first" : "Lighting"}
            >
              {(cleanAssetUrl
                ? ([
                    ...(splatUrl
                      ? ([["photoreal", "Photoreal", "Buyers start with the photoreal walkthrough (they can switch to the photos on the model)"]] as const)
                      : []),
                    ["captured", "Photos on", "Buyers start with your photos painted on the model (they can turn them off)"],
                    ["studio", "Photos off", "Buyers start with the clean 3D model (they can turn the photos on)"],
                  ] as const)
                : ([
                    ["studio", "Studio light", "Soft studio lighting — best for iPhone scans and modeled homes"],
                    ["captured", "As captured", "Unlit, exactly as scanned — best for photo-textured scans"],
                  ] as const)
              ).map(([value, label, title]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={appearance === value}
                  title={title}
                  onClick={async () => {
                    if (appearance === value) return;
                    const previous = appearance;
                    setAppearance(value);
                    const res = await setAppearanceAction(propertyId, value);
                    if (!res.ok) {
                      setAppearance(previous);
                      flash("error", res.error ?? "Could not change the lighting.");
                    } else if (cleanAssetUrl)
                      flash(
                        "ok",
                        value === "photoreal"
                          ? "Buyers start with the photoreal walkthrough"
                          : value === "captured"
                            ? "Buyers start with the photos on"
                            : "Buyers start with the photos off",
                      );
                    else flash("ok", value === "captured" ? "Showing the capture as scanned" : "Using studio lighting");
                  }}
                  className={`rounded-full px-3 py-1 transition ${appearance === value ? "bg-white text-neutral-900" : "text-white/80 hover:text-white"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {planFloor && space.rooms.some((r) => r.floorId === planFloor.id) && (
              <div className="glass absolute bottom-4 right-4 hidden w-56 rounded-2xl p-2 md:block">
                {floors.length > 1 && (
                  <div className="mb-1 flex gap-1">
                    {floors.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setPlanFloorId(f.id)}
                        className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${f.id === planFloor.id ? "bg-white text-neutral-900" : "text-white/70"}`}
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                )}
                <FloorPlan
                  floor={planFloor}
                  rooms={space.rooms.filter((r) => r.floorId === planFloor.id)}
                  currentRoomId={currentRoomId}
                  poseRef={poseRef}
                  onRoomClick={(id) => apiRef.current?.goToRoom(id)}
                  className="h-36 w-full"
                />
              </div>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save rooms
            </Button>
            <Button variant="secondary" onClick={setCover} disabled={!loaded || coverBusy}>
              {coverBusy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} Use view as cover photo
            </Button>
            <Link href={`/dashboard/properties/${propertyId}/preview`} className={buttonClass("ghost")}>
              <Camera className="size-4" /> Preview tour
            </Link>
            {dirty && !message && <span className="text-sm text-amber-700">Unsaved changes</span>}
            {message && <span className={`text-sm ${message.tone === "ok" ? "text-emerald-700" : "text-red-600"}`}>{message.text}</span>}
          </div>
        </div>
      </section>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
  disabled,
  danger,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`grid size-7 place-items-center rounded-full text-neutral-500 transition disabled:opacity-30 ${danger ? "hover:bg-red-50 hover:text-red-600" : "hover:bg-white hover:text-ink"}`}
    >
      {children}
    </button>
  );
}
