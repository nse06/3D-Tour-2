"use client";

import {
  ArrowRight,
  Box,
  Check,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Info,
  Layers,
  List,
  Loader2,
  MapIcon,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Share2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cityLine, formatBaths, formatNumber, formatPrice } from "@/lib/format";
import { useMediaQuery, useQueryParam } from "@/lib/hooks";
import { sortedFloors, walkthroughOrder } from "@/lib/tour/navigation";
import type { TourData, TourRoom, Waypoint } from "@/lib/tour/types";
import { FloorPlan } from "./FloorPlan";
import type { LivePose, ViewerApi } from "./viewer-types";

const TourScene = dynamic(() => import("./TourScene"), { ssr: false });

interface Props {
  data: TourData;
  /** Optional banner (e.g. "Preview — not yet published"). */
  banner?: ReactNode;
  /** Public tour path/URL to share; defaults to the current page. `null` = not shareable yet (draft). */
  shareUrl?: string | null;
}

const FALLBACK_START: Waypoint = { position: [0, 1.6, 0], yaw: 0, pitch: 0 };

let webglSupport: boolean | null = null;
function hasWebGL() {
  if (webglSupport === null) {
    try {
      const c = document.createElement("canvas");
      webglSupport = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}
const noopSubscribe = () => () => {};

/** Seconds spent looking around each room during the guided autoplay. */
const DWELL_MS = 5200;

export default function TourViewer({ data, banner, shareUrl }: Props) {
  const { property, space } = data;
  const floors = useMemo(() => sortedFloors(space), [space]);
  const order = useMemo(() => walkthroughOrder(space), [space]);
  const startRoom = order[0];
  const startWaypoint = startRoom?.waypoint ?? FALLBACK_START;

  const apiRef = useRef<ViewerApi | null>(null);
  const poseRef = useRef<LivePose>({ position: startWaypoint.position, yaw: startWaypoint.yaw, floorId: startRoom?.floorId ?? null });

  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(startRoom?.id ?? null);
  const [planFloorId, setPlanFloorId] = useState<string | null>(startRoom?.floorId ?? floors[0]?.id ?? null);
  const isTouch = useMediaQuery("(pointer: coarse)");
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const aoParam = useQueryParam("ao");
  const effects = aoParam === "1" || (!isTouch && aoParam !== "0");
  const [planPref, setPlanPref] = useState<boolean | null>(null);
  const planOpen = planPref ?? !(isTouch || isNarrow);
  const setPlanOpen = (open: boolean) => setPlanPref(open);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [fade, setFade] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [titleCard, setTitleCard] = useState<{ room: TourRoom; key: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  // Photo scans with a clean model: photos on or off. The realtor's default view picks the start.
  const [startWithPhotos] = useState(!(data.cleanAssetUrl && data.appearance === "studio"));
  const [photos, setPhotos] = useState(startWithPhotos);
  const [showingClean, setShowingClean] = useState(!startWithPhotos);
  const [switchFailed, setSwitchFailed] = useState(false);
  const hasClean = !!data.cleanAssetUrl && !switchFailed;
  const switching = hasClean && showingClean === photos;
  const pendingTitle = useRef<TourRoom | null>(null);
  const webgl = useSyncExternalStore(noopSubscribe, hasWebGL, () => true);

  const roomsById = useMemo(() => new Map(space.rooms.map((r) => [r.id, r])), [space]);
  const floorsById = useMemo(() => new Map(floors.map((f) => [f.id, f])), [floors]);
  const currentRoom = currentRoomId ? (roomsById.get(currentRoomId) ?? null) : null;
  const currentIndex = currentRoom ? order.findIndex((r) => r.id === currentRoom.id) : -1;
  const planFloor = (planFloorId && floorsById.get(planFloorId)) || floors[0] || null;

  // Small debugging / QA handle (used by automated screenshot checks).
  useEffect(() => {
    (window as unknown as { __atrium?: unknown }).__atrium = { api: apiRef, space, order };
  }, [space, order]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // The plan follows the visitor between floors.
  const lastFloorRef = useRef(startRoom?.floorId ?? null);
  const handleRoomChange = useCallback(
    (roomId: string | null) => {
      setCurrentRoomId(roomId);
      const room = roomId ? roomsById.get(roomId) : null;
      if (room && room.floorId !== lastFloorRef.current) {
        lastFloorRef.current = room.floorId;
        setPlanFloorId(room.floorId);
      }
    },
    [roomsById],
  );

  const goToRoom = useCallback(
    (roomId: string) => {
      const room = roomsById.get(roomId);
      if (!room || !apiRef.current) return;
      apiRef.current.goToRoom(roomId);
      setRoomsOpen(false);
      setHint(false);
      pendingTitle.current = room;
    },
    [roomsById],
  );

  const step = useCallback(
    (delta: number) => {
      if (!order.length) return;
      const idx = currentIndex < 0 ? 0 : (currentIndex + delta + order.length) % order.length;
      goToRoom(order[idx].id);
    },
    [currentIndex, order, goToRoom],
  );

  // Keyboard shortcuts for room-to-room navigation.
  useEffect(() => {
    if (!entered) return;
    const onKey = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) return;
      if (e.key === "]" || e.key === "PageDown" || e.key.toLowerCase() === "n") step(1);
      if (e.key === "[" || e.key === "PageUp" || e.key.toLowerCase() === "p") step(-1);
      if (e.key === "Escape") {
        setInfoOpen(false);
        setRoomsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entered, step]);

  useEffect(() => {
    if (!titleCard) return;
    const t = setTimeout(() => setTitleCard(null), 2600);
    return () => clearTimeout(t);
  }, [titleCard]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // Room names appear as the camera arrives, like a title card in a film.
  const handleMovingChange = useCallback((m: boolean) => {
    setMoving(m);
    if (!m && pendingTitle.current) {
      setTitleCard({ room: pendingTitle.current, key: Date.now() });
      pendingTitle.current = null;
    }
  }, []);

  const stopAutoplay = useCallback(() => setPlaying(false), []);

  // Guided autoplay: dwell and look around, then glide to the next room.
  useEffect(() => {
    if (!playing || moving || !entered) return;
    const t = setTimeout(() => {
      if (currentIndex >= order.length - 1) setPlaying(false);
      else step(1);
    }, DWELL_MS);
    return () => clearTimeout(t);
  }, [playing, moving, entered, currentIndex, order.length, step]);

  const togglePlay = () => {
    if (playing) return setPlaying(false);
    setPlaying(true);
    setHint(false);
    if (currentIndex >= order.length - 1 && order[0]) goToRoom(order[0].id);
  };

  const enter = () => {
    setEntered(true);
    setHint(true);
    pendingTitle.current = startRoom ?? null;
    setTimeout(() => setHint(false), 7000);
  };

  const share = async () => {
    if (shareUrl === null) {
      setToast("Publish this tour to get a shareable link");
      return;
    }
    const url = shareUrl ? new URL(shareUrl, window.location.origin).toString() : window.location.href;
    const title = `${property.addressLine} — 3D walkthrough`;
    try {
      if (isTouch && navigator.share) {
        await navigator.share({ title, text: `Walk through ${property.addressLine} in 3D`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setToast("Link copied — send it to anyone");
    } catch {
      setToast(url);
    }
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };

  const roomsOnPlanFloor = planFloor ? space.rooms.filter((r) => r.floorId === planFloor.id) : [];
  const currentFloor = currentRoom ? floorsById.get(currentRoom.floorId) : null;

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#1a1816] text-white">
      {webgl && (
        <TourScene
          assetUrl={data.assetUrl}
          cleanAssetUrl={data.cleanAssetUrl}
          photos={photos}
          onShowingClean={setShowingClean}
          onSwitchError={() => {
            setSwitchFailed(true);
            setPhotos(startWithPhotos);
            setToast(startWithPhotos ? "The clean model couldn't be loaded" : "The photos couldn't be loaded");
          }}
          appearance={data.appearance}
          space={space}
          startWaypoint={startWaypoint}
          apiRef={apiRef}
          poseRef={poseRef}
          active={entered}
          mode="tour"
          onRoomChange={handleRoomChange}
          onMovingChange={handleMovingChange}
          autoPan={playing && !moving}
          onUserInteract={stopAutoplay}
          onFade={setFade}
          onProgress={setProgress}
          onLoaded={() => {
            setProgress(1);
            setLoaded(true);
          }}
          onError={setError}
          effects={effects}
        />
      )}

      {/* Cinematic vignette keeps overlays legible without boxing in the scene. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.28)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/45 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/45 to-transparent" />
      <div className={`pointer-events-none absolute inset-0 bg-black transition-opacity duration-300 ${fade ? "opacity-100" : "opacity-0"}`} />

      {banner && <div className="absolute inset-x-0 top-0 z-30 flex justify-center pt-3">{banner}</div>}

      {/* Address block */}
      <header
        className={`absolute left-4 top-4 z-20 max-w-[70vw] transition-all duration-700 md:left-8 md:top-7 ${entered ? "opacity-100" : "opacity-0"} ${banner ? "mt-10" : ""}`}
      >
        <p className="text-[10px] font-medium uppercase tracking-[0.32em] text-white/60">3D Walkthrough</p>
        <h1 className="font-display mt-1 text-2xl leading-tight text-white drop-shadow md:text-[34px]">{property.addressLine}</h1>
        <p className="mt-0.5 text-sm text-white/75 md:text-[15px]">{cityLine(property)}</p>
      </header>

      {/* Top-right actions */}
      <div
        className={`absolute right-4 top-4 z-20 flex gap-2 transition-opacity duration-700 md:right-8 md:top-7 ${entered ? "opacity-100" : "opacity-0"} ${banner ? "mt-10" : ""}`}
      >
        <IconButton label="Share tour" onClick={share}>
          <Share2 className="size-[18px]" />
        </IconButton>
        <IconButton label="Property details" onClick={() => setInfoOpen(true)}>
          <Info className="size-[18px]" />
        </IconButton>
        <IconButton label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen} className="hidden md:flex">
          {fullscreen ? <Minimize2 className="size-[18px]" /> : <Maximize2 className="size-[18px]" />}
        </IconButton>
      </div>

      {/* Desktop room navigator */}
      {entered && (
        <nav className="glass absolute left-8 top-36 z-20 hidden w-60 rounded-2xl p-2 md:block" aria-label="Rooms">
          <RoomList floors={floors} rooms={space.rooms} currentRoomId={currentRoomId} onSelect={goToRoom} />
        </nav>
      )}

      {/* Floor plan */}
      {entered && planFloor && planOpen && (
        <div className="glass-strong absolute bottom-24 right-4 z-20 w-[min(88vw,340px)] rounded-2xl p-3 md:bottom-8 md:right-8">
          <div className="mb-1 flex items-center justify-between gap-2 px-1">
            <div className="flex gap-1">
              {floors.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setPlanFloorId(f.id)}
                  className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wider transition ${
                    f.id === planFloor.id ? "bg-white text-neutral-900" : "text-white/70 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
            <button
              onClick={() => setPlanOpen(false)}
              className="rounded-full p-1 text-white/60 hover:bg-white/10 hover:text-white"
              aria-label="Hide floor plan"
            >
              <X className="size-4" />
            </button>
          </div>
          <FloorPlan
            floor={planFloor}
            rooms={roomsOnPlanFloor}
            currentRoomId={currentRoomId}
            poseRef={poseRef}
            onRoomClick={goToRoom}
            className="h-56 w-full md:h-60"
          />
        </div>
      )}

      {/* Bottom controls */}
      {entered && order.length > 0 && (
        <div className="absolute inset-x-0 bottom-4 z-20 flex items-end justify-center gap-2 px-4 md:bottom-8">
          <IconButton label="Rooms" onClick={() => setRoomsOpen(true)} className="md:hidden">
            <List className="size-[18px]" />
          </IconButton>
          <div className="glass flex items-center gap-1 rounded-full p-1.5">
            <button
              onClick={() => step(-1)}
              className="grid size-10 place-items-center rounded-full text-white/85 transition hover:bg-white/15 hover:text-white"
              aria-label="Previous room"
            >
              <ChevronLeft className="size-5" />
            </button>
            <button
              onClick={() => setRoomsOpen(true)}
              className="min-w-[132px] px-2 text-center md:min-w-[210px] md:cursor-default md:px-3"
              aria-label="Current room"
            >
              <span className="block text-[15px] font-medium leading-tight">{currentRoom?.name ?? "Exploring"}</span>
              <span className="block whitespace-nowrap text-[10px] uppercase tracking-[0.14em] text-white/55 md:text-[11px] md:tracking-[0.18em]">
                {currentFloor?.name ?? ""}{" "}
                {currentIndex >= 0 && (
                  <>
                    · {currentIndex + 1}/{order.length}
                  </>
                )}
              </span>
            </button>
            <button
              onClick={() => step(1)}
              className="grid size-10 place-items-center rounded-full bg-white text-neutral-900 transition hover:bg-white/90"
              aria-label="Next room"
            >
              <ChevronRight className="size-5" />
            </button>
          </div>
          <IconButton label={planOpen ? "Hide floor plan" : "Show floor plan"} onClick={() => setPlanOpen(!planOpen)} active={planOpen}>
            <MapIcon className="size-[18px]" />
          </IconButton>
          {hasClean && (
            <button
              onClick={() => {
                setPhotos(!photos);
                setToast(photos ? "Photos off — the clean 3D model" : "Photos on");
              }}
              aria-pressed={photos}
              aria-label={photos ? "Turn photos off" : "Turn photos on"}
              title={photos ? "Turn photos off: see the clean 3D model" : "Turn photos on"}
              className="glass flex h-11 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium text-white/90 transition hover:bg-white/20 hover:text-white sm:pr-4"
            >
              {switching ? <Loader2 className="size-4 animate-spin" /> : photos ? <ImageIcon className="size-4" /> : <Box className="size-4" />}
              <span className="hidden sm:inline">{photos ? "Photos on" : "Photos off"}</span>
            </button>
          )}
          <button
            onClick={togglePlay}
            aria-label={playing ? "Pause guided tour" : "Play guided tour"}
            title={playing ? "Pause guided tour" : "Play guided tour"}
            className={`glass hidden h-11 items-center gap-2 rounded-full pl-3.5 pr-4 text-[13px] font-medium text-white/90 transition hover:bg-white/20 hover:text-white sm:flex ${playing ? "ring-1 ring-[#d6b67c]/70" : ""}`}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            {playing ? "Pause" : "Guided tour"}
          </button>
          <IconButton label={playing ? "Pause guided tour" : "Play guided tour"} onClick={togglePlay} active={playing} className="sm:hidden">
            {playing ? <Pause className="size-[18px]" /> : <Play className="size-[18px]" />}
          </IconButton>
        </div>
      )}

      {/* Arrival title card */}
      {entered && titleCard && (
        <div key={titleCard.key} className="pointer-events-none absolute inset-x-0 top-[38%] z-10 flex justify-center">
          <div className="title-card text-center">
            <p className="text-[11px] uppercase tracking-[0.4em] text-white/70">{floorsById.get(titleCard.room.floorId)?.name}</p>
            <p className="font-display mt-1 text-4xl text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.45)] md:text-6xl">{titleCard.room.name}</p>
          </div>
        </div>
      )}

      {/* First-time hint */}
      {entered && (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center transition-opacity duration-700 md:bottom-28 ${hint && !moving ? "opacity-100" : "opacity-0"}`}
        >
          <div className="glass rounded-full px-5 py-2.5 text-[13px] text-white/90">
            {isTouch ? "Drag to look around · Tap the floor to walk" : "Drag to look around · Click the floor to walk · Arrow keys to move"}
          </div>
        </div>
      )}

      {/* Mobile rooms sheet */}
      {roomsOpen && (
        <div className="absolute inset-0 z-40 flex items-end bg-black/40 md:items-center md:justify-center" onClick={() => setRoomsOpen(false)}>
          <div className="glass-strong max-h-[75vh] w-full overflow-y-auto rounded-t-3xl p-3 pb-6 md:w-96 md:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/30 md:hidden" />
            <RoomList floors={floors} rooms={space.rooms} currentRoomId={currentRoomId} onSelect={goToRoom} large />
          </div>
        </div>
      )}

      {/* Property info drawer */}
      <InfoDrawer open={infoOpen} onClose={() => setInfoOpen(false)} data={data} onShare={share} />

      {toast && (
        <div className="absolute left-1/2 top-20 z-50 -translate-x-1/2">
          <div className="glass-strong flex items-center gap-2 rounded-full px-4 py-2 text-sm">
            <Check className="size-4 text-[#d6b67c]" /> {toast}
          </div>
        </div>
      )}

      <LoadingOverlay
        data={data}
        progress={progress}
        loaded={loaded}
        entered={entered}
        error={webgl ? error : "Your browser has 3D graphics (WebGL) turned off. Try the latest Chrome, Safari, Edge or Firefox."}
        onEnter={enter}
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  className = "",
  active = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`glass grid size-11 place-items-center rounded-full text-white/90 transition hover:bg-white/20 hover:text-white ${active ? "ring-1 ring-white/50" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

function RoomList({
  floors,
  rooms,
  currentRoomId,
  onSelect,
  large = false,
}: {
  floors: ReturnType<typeof sortedFloors>;
  rooms: TourRoom[];
  currentRoomId: string | null;
  onSelect: (id: string) => void;
  large?: boolean;
}) {
  return (
    <div className="space-y-2">
      {floors.map((f) => {
        const list = rooms.filter((r) => r.floorId === f.id).sort((a, b) => a.order - b.order);
        if (!list.length) return null;
        return (
          <div key={f.id}>
            <p className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-white/50">
              <Layers className="size-3" /> {f.name}
            </p>
            <ul>
              {list.map((r) => {
                const active = r.id === currentRoomId;
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => onSelect(r.id)}
                      className={`group flex w-full items-center gap-3 rounded-xl px-3 text-left transition ${large ? "py-3 text-base" : "py-2 text-[14px]"} ${
                        active ? "bg-white/15 text-white" : "text-white/75 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full transition ${active ? "bg-[#d6b67c] shadow-[0_0_10px_#d6b67c]" : "bg-white/25 group-hover:bg-white/60"}`}
                      />
                      {r.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function InfoDrawer({ open, onClose, data, onShare }: { open: boolean; onClose: () => void; data: TourData; onShare: () => void }) {
  const p = data.property;
  return (
    <>
      <div
        className={`absolute inset-0 z-40 bg-black/30 transition-opacity duration-300 ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <aside
        className={`absolute inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col bg-[#f7f4ef] text-neutral-900 shadow-2xl transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="flex items-center justify-between px-7 pt-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-neutral-500">Property details</p>
          <button onClick={onClose} className="rounded-full p-2 text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-900" aria-label="Close details">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-7 pb-8">
          <p className="font-display mt-4 text-4xl">{formatPrice(p.price)}</p>
          <h2 className="mt-3 text-lg font-medium">{p.addressLine}</h2>
          <p className="text-sm text-neutral-500">{cityLine(p)}</p>
          <div className="mt-6 grid grid-cols-3 divide-x divide-neutral-300 border-y border-neutral-300 py-4 text-center">
            <Stat value={String(p.bedrooms)} label="Beds" />
            <Stat value={formatBaths(p.bathrooms)} label="Baths" />
            <Stat value={formatNumber(p.squareFeet)} label="Sq Ft" />
          </div>
          {p.title && <p className="font-display mt-6 text-2xl leading-snug">{p.title}</p>}
          <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-neutral-700">
            {p.description.split(/\n+/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
          <button
            onClick={onShare}
            className="mt-8 flex w-full items-center justify-center gap-2 rounded-full bg-neutral-900 px-5 py-3.5 text-sm font-medium text-white transition hover:bg-neutral-800"
          >
            <Share2 className="size-4" /> Share this walkthrough
          </button>
          <p className="mt-6 text-center text-xs text-neutral-400">
            {data.source === "ios_scan" ? "Captured with iPhone LiDAR" : "Interactive 3D capture"} · Powered by Atrium
          </p>
        </div>
      </aside>
    </>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="font-display text-2xl">{value}</p>
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
    </div>
  );
}

function LoadingOverlay({
  data,
  progress,
  loaded,
  entered,
  error,
  onEnter,
}: {
  data: TourData;
  progress: number;
  loaded: boolean;
  entered: boolean;
  error: string | null;
  onEnter: () => void;
}) {
  const p = data.property;
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!entered) return;
    const t = setTimeout(() => setGone(true), 900);
    return () => clearTimeout(t);
  }, [entered]);
  if (gone) return null;
  return (
    <div
      className={`absolute inset-0 z-[60] flex items-center justify-center transition-opacity duration-[900ms] ${entered ? "pointer-events-none opacity-0" : "opacity-100"}`}
    >
      <div className="absolute inset-0 bg-[#141210]" />
      {p.coverImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.coverImageUrl} alt="" className="absolute inset-0 size-full scale-105 object-cover opacity-55 blur-[2px]" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/50" />
      <div className="relative mx-6 max-w-xl text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.42em] text-white/70">Immersive 3D Walkthrough</p>
        <h1 className="font-display mt-4 text-5xl leading-[1.05] text-white md:text-7xl">{p.addressLine}</h1>
        <p className="mt-3 text-base text-white/80 md:text-lg">{cityLine(p)}</p>
        <p className="mt-5 text-sm tracking-wide text-white/70">
          {formatPrice(p.price)} · {p.bedrooms} Beds · {formatBaths(p.bathrooms)} Baths · {formatNumber(p.squareFeet)} Sq Ft
        </p>
        <div className="mt-10 flex h-14 items-center justify-center">
          {error ? (
            <p className="max-w-sm text-sm text-red-200">This 3D capture could not be loaded. {error}</p>
          ) : loaded ? (
            <button
              onClick={onEnter}
              className="group flex items-center gap-3 rounded-full bg-white py-3.5 pl-7 pr-5 text-[15px] font-medium text-neutral-900 shadow-[0_10px_40px_rgba(0,0,0,0.35)] transition hover:scale-[1.02]"
              autoFocus
            >
              Enter the home
              <span className="grid size-8 place-items-center rounded-full bg-neutral-900 text-white transition group-hover:translate-x-0.5">
                <ArrowRight className="size-4" />
              </span>
            </button>
          ) : (
            <div className="w-56">
              <div className="h-px w-full overflow-hidden bg-white/20">
                <div className="h-full bg-white transition-[width] duration-300" style={{ width: `${Math.max(4, progress * 100)}%` }} />
              </div>
              <p className="mt-3 text-[11px] uppercase tracking-[0.3em] text-white/55">Preparing the home</p>
            </div>
          )}
        </div>
      </div>
      <p className="absolute bottom-6 text-[11px] uppercase tracking-[0.3em] text-white/40">Atrium</p>
    </div>
  );
}
