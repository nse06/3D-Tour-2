// "1234 Sheridan Road" — a fictional North Shore (Wilmette, IL) luxury home.
//
// This file stands in for what the future iPhone capture pipeline will
// produce: a textured 3D model of the property PLUS a spatial manifest
// (floors, room footprints, camera waypoints and walkable links). RoomPlan
// gives us room polygons; ARKit gives us the camera trajectory, from which
// waypoints and links are derived. Here we author both by hand.
//
// Coordinate system: meters, +y up, the front door faces +z.

import * as THREE from "three";
import { HouseBuilder, buildWallRun } from "./builder.mjs";
import * as T from "./textures.mjs";
import * as F from "./furniture.mjs";

const F1 = 0;
const H1 = 3.0;
const F2 = 3.3;
const H2 = 6.2;
const EYE = 1.6;
const EXT_T = 0.22;
const INT_T = 0.075;

export function buildHouse() {
  const b = new HouseBuilder();
  const M = defineMaterials(b);

  const rooms = defineRooms(M);
  const openings = defineOpenings();
  const windowMats = { pane: M.windowPane, frame: M.windowFrame, sill: M.trim };

  for (const room of rooms) buildRoomShell(b, M, room, openings, windowMats);
  buildEntryVoid(b, M, openings, windowMats);
  buildUpperHallSouthWall(b, M, openings, windowMats);
  buildStairs(b, M);

  furnishEntry(b, M);
  furnishLiving(b, M);
  furnishDining(b, M);
  furnishKitchen(b, M);
  furnishOffice(b, M);
  furnishLanding(b, M);
  furnishPrimary(b, M);
  furnishPrimaryBath(b, M);
  furnishBedroom2(b, M);
  furnishBedroom3(b, M);

  return { builder: b, manifest: buildManifest(rooms) };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function defineMaterials(b) {
  b.texture("oak", T.oakFloor(1024, 8));
  b.texture("walnut", T.walnut(512));
  b.texture("marble", T.marble(1024));
  b.texture("marbleTile", T.marbleTile(1024, 2));
  b.texture("travertine", T.travertine(512));
  b.texture("fabric", T.fabric(256));
  b.texture("plaster", T.plaster(256));
  b.texture("window", T.windowView(512, 512));
  b.texture("shadow", T.contactShadow(128), "png");
  b.texture("rugLiving", T.rug(1024, 840, { field: [226, 218, 204], border: [196, 184, 166], accent: [168, 152, 132] }, "plain", 71));
  b.texture("rugDining", T.rug(768, 1024, { field: [132, 146, 156], border: [70, 82, 96], accent: [208, 196, 172] }, "medallion", 72));
  b.texture("rugOffice", T.rug(768, 1024, { field: [142, 74, 52], border: [58, 46, 40], accent: [206, 168, 112] }, "medallion", 73));
  b.texture("rugBed", T.rug(1024, 900, { field: [222, 214, 202], border: [182, 170, 154], accent: [196, 186, 172] }, "lattice", 74));
  b.texture("rugBlue", T.rug(1024, 800, { field: [196, 204, 210], border: [92, 108, 124], accent: [150, 164, 176] }, "stripe", 75));
  b.texture("artField", T.artColorField(512, 640));
  b.texture("artCircles", T.artCircles(512, 512));
  b.texture("artLake", T.artLake(1024, 512));
  b.texture("artLines", T.artLines(512, 640));

  const world = (tile) => ({ mode: "world", tile });
  const M = {
    wall: b.material("Wall_Paint", { color: "#efebe4", map: "plaster", uv: world(2.5), roughness: 0.93 }),
    wallGreige: b.material("Wall_Greige", { color: "#e3d9cc", map: "plaster", uv: world(2.5), roughness: 0.93 }),
    wallSage: b.material("Wall_Sage", { color: "#dde1d6", map: "plaster", uv: world(2.5), roughness: 0.93 }),
    wallMist: b.material("Wall_Mist", { color: "#dfe4e6", map: "plaster", uv: world(2.5), roughness: 0.93 }),
    wallOffice: b.material("Wall_Library_Green", { color: "#3d4a3e", map: "plaster", uv: world(2.5), roughness: 0.7 }),
    ceiling: b.material("Ceiling", { color: "#f7f5f1", map: "plaster", uv: world(3), roughness: 0.95 }),
    trim: b.material("Trim_White", { color: "#f3f1ec", roughness: 0.45 }),
    trimOffice: b.material("Trim_Library_Green", { color: "#344035", roughness: 0.5 }),
    oak: b.material("Floor_White_Oak", { color: "#ffffff", map: "oak", uv: world(2.4), roughness: 0.5 }),
    marble: b.material("Stone_Calacatta", { color: "#ffffff", map: "marble", uv: world(1.8), roughness: 0.18 }),
    marbleTile: b.material("Floor_Marble_Tile", { color: "#ffffff", map: "marbleTile", uv: world(1.2), roughness: 0.3 }),
    travertine: b.material("Stone_Travertine", { color: "#ffffff", map: "travertine", uv: world(1.2), roughness: 0.75 }),
    walnut: b.material("Wood_Walnut", { color: "#ffffff", map: "walnut", uv: world(0.9), roughness: 0.5 }),
    walnutDark: b.material("Wood_Walnut_Dark", { color: "#8a7a70", map: "walnut", uv: world(0.9), roughness: 0.45 }),
    cabinet: b.material("Cabinet_Warm_White", { color: "#ebe6dc", roughness: 0.42 }),
    cabinetGreen: b.material("Cabinet_Forest", { color: "#33443a", roughness: 0.42 }),
    sofa: b.material("Fabric_Boucle", { color: "#e7e0d4", map: "fabric", uv: world(0.35), roughness: 0.97 }),
    linen: b.material("Fabric_Linen", { color: "#f4f1eb", map: "fabric", uv: world(0.3), roughness: 0.97 }),
    linenTaupe: b.material("Fabric_Taupe", { color: "#b8a68f", map: "fabric", uv: world(0.3), roughness: 0.97 }),
    velvetNavy: b.material("Fabric_Navy_Velvet", { color: "#2c3850", map: "fabric", uv: world(0.3), roughness: 0.8 }),
    sage: b.material("Fabric_Sage", { color: "#8f9b86", map: "fabric", uv: world(0.3), roughness: 0.95 }),
    rust: b.material("Fabric_Rust", { color: "#a65a3a", map: "fabric", uv: world(0.3), roughness: 0.92 }),
    leather: b.material("Leather_Cognac", { color: "#8e5a36", roughness: 0.48 }),
    duvet: b.material("Bedding_White", { color: "#f7f6f2", map: "fabric", uv: world(0.25), roughness: 0.98 }),
    drape: b.material("Drape_Linen", { color: "#ece6dc", map: "fabric", uv: world(0.4), roughness: 0.98 }),
    brass: b.material("Metal_Brass", { color: "#c7a265", roughness: 0.32, metalness: 1 }),
    blackMetal: b.material("Metal_Black", { color: "#1f1f21", roughness: 0.5, metalness: 0.5 }),
    steel: b.material("Metal_Steel", { color: "#c4c7ca", roughness: 0.3, metalness: 1 }),
    mirror: b.material("Mirror", { color: "#ffffff", roughness: 0.03, metalness: 1 }),
    porcelain: b.material("Porcelain", { color: "#fafaf8", roughness: 0.12 }),
    water: b.material("Water", { color: "#c9d6d8", roughness: 0.05, metalness: 0.2 }),
    glass: b.material("Glass_Shower", { color: "#e4eef0", roughness: 0.04, opacity: 0.16, blend: true, doubleSided: true }),
    ceramic: b.material("Ceramic_Cream", { color: "#e2dacd", roughness: 0.55 }),
    ceramicDark: b.material("Ceramic_Charcoal", { color: "#3b3836", roughness: 0.5 }),
    soil: b.material("Soil", { color: "#3a2f26", roughness: 1 }),
    stem: b.material("Stem", { color: "#5b4a36", roughness: 0.9 }),
    leaf: b.material("Leaf_Deep", { color: "#3f5a30", roughness: 0.7 }),
    leaf2: b.material("Leaf_Light", { color: "#62803f", roughness: 0.7 }),
    granite: b.material("Stone_Black", { color: "#151515", roughness: 0.25 }),
    firebox: b.material("Firebox", { color: "#181513", roughness: 1 }),
    fire: b.material("Fire_Glow", { color: "#000000", emissive: "#ff8f45", emissiveStrength: 4 }),
    ember: b.material("Fire_Ember", { color: "#2a1a12", emissive: "#ff5a1f", emissiveStrength: 1.2, roughness: 1 }),
    bulb: b.material("Light_Bulb", { color: "#000000", emissive: "#fff1d8", emissiveStrength: 5 }),
    globe: b.material("Light_Globe", { color: "#000000", emissive: "#ffe9c9", emissiveStrength: 2.4 }),
    shade: b.material("Lamp_Shade", { color: "#f1e6d4", emissive: "#ffd8a6", emissiveStrength: 0.9, roughness: 0.9 }),
    windowPane: b.material("Window_Daylight", { color: "#000000", emissive: "#ffffff", emissiveMap: "window", emissiveStrength: 1.7, roughness: 1 }),
    windowFrame: b.material("Window_Frame", { color: "#232325", roughness: 0.45, metalness: 0.3 }),
    shadow: b.material("Contact_Shadow", { color: "#ffffff", map: "shadow", blend: true, roughness: 1 }),
    rugLiving: b.material("Rug_Living", { color: "#ffffff", map: "rugLiving", roughness: 1 }),
    rugDining: b.material("Rug_Dining", { color: "#ffffff", map: "rugDining", roughness: 1 }),
    rugOffice: b.material("Rug_Office", { color: "#ffffff", map: "rugOffice", roughness: 1 }),
    rugBed: b.material("Rug_Bedroom", { color: "#ffffff", map: "rugBed", roughness: 1 }),
    rugBlue: b.material("Rug_Blue", { color: "#ffffff", map: "rugBlue", roughness: 1 }),
    artField: b.material("Art_ColorField", { color: "#ffffff", map: "artField", roughness: 0.9 }),
    artCircles: b.material("Art_Circles", { color: "#ffffff", map: "artCircles", roughness: 0.9 }),
    artLake: b.material("Art_Lake", { color: "#ffffff", map: "artLake", roughness: 0.9 }),
    artLines: b.material("Art_Lines", { color: "#ffffff", map: "artLines", roughness: 0.9 }),
    fruit: b.material("Fruit_Lemon", { color: "#e8c547", roughness: 0.5 }),
    doorWood: b.material("Door_Walnut", { color: "#d8d0c8", map: "walnut", uv: world(0.9), roughness: 0.45 }),
  };
  const bookColors = ["#6b2e2a", "#2d3e50", "#c8b48a", "#3d4d3a", "#8a7a64", "#262626", "#b5654a", "#e2dccf", "#4f5d6b"];
  M.books = bookColors.map((c, i) => b.material(`Book_${i}`, { color: c, roughness: 0.8 }));
  return M;
}

// ---------------------------------------------------------------------------
// Plan: rooms + openings
// ---------------------------------------------------------------------------

function defineRooms(M) {
  // rect: [x0, x1, z0, z1]; ext: exterior sides (n=-z, s=+z, w=-x, e=+x)
  return [
    { key: "entry", name: "Entry", floor: "main", rect: [-2.5, 2.5, -1, 6.5], y0: F1, y1: H1, ext: "s", wall: M.wall, trim: M.trim, floorMat: M.marbleTile, ceiling: [[-2.5, 2.5, -1, 0.8]] },
    { key: "living", name: "Living Room", floor: "main", rect: [2.5, 9, 0.5, 6.5], y0: F1, y1: H1, ext: "se", wall: M.wall, trim: M.trim, floorMat: M.oak },
    { key: "dining", name: "Dining Room", floor: "main", rect: [2.5, 9, -6.5, 0.5], y0: F1, y1: H1, ext: "ne", wall: M.wallMist, trim: M.trim, floorMat: M.oak },
    { key: "kitchen", name: "Kitchen", floor: "main", rect: [-8, 2.5, -6.5, -1], y0: F1, y1: H1, ext: "nw", wall: M.wall, trim: M.trim, floorMat: M.oak },
    { key: "office", name: "Office", floor: "main", rect: [-8, -2.5, -1, 6.5], y0: F1, y1: H1, ext: "sw", wall: M.wallOffice, trim: M.trimOffice, floorMat: M.oak },
    { key: "landing", name: "Upper Landing", floor: "upper", rect: [-8, 2.5, -1.2, 0.8], y0: F2, y1: H2, ext: "w", skip: "s", wall: M.wall, trim: M.trim, floorMat: M.oak },
    { key: "primary", name: "Primary Bedroom", floor: "upper", rect: [2.5, 9, -1.5, 6.5], y0: F2, y1: H2, ext: "se", wall: M.wallGreige, trim: M.trim, floorMat: M.oak },
    { key: "primaryBath", name: "Primary Bathroom", floor: "upper", rect: [2.5, 9, -6.5, -1.5], y0: F2, y1: H2, ext: "ne", wall: M.wall, trim: M.trim, floorMat: M.marbleTile },
    { key: "bedroom2", name: "Bedroom 2", floor: "upper", rect: [-8, -2.5, 0.8, 6.5], y0: F2, y1: H2, ext: "sw", wall: M.wallMist, trim: M.trim, floorMat: M.oak },
    { key: "bedroom3", name: "Bedroom 3", floor: "upper", rect: [-8, -2.5, -6.5, -1.2], y0: F2, y1: H2, ext: "nw", wall: M.wallSage, trim: M.trim, floorMat: M.oak },
  ];
}

/**
 * Openings in vertical planes. plane 'x' => wall plane x = at, span along z.
 * plane 'z' => wall plane z = at, span along x.
 */
function defineOpenings() {
  const door = (plane, at, a, b, y0, h = 2.7, kind = "opening") => ({ plane, at, span: [a, b], y: [y0, y0 + h], kind });
  const win = (plane, at, a, b, y0, y1) => ({ plane, at, span: [a, b], y: [y0, y1], kind: "window" });
  return [
    // --- Main level ---
    door("z", 6.5, -0.9, 0.9, F1, 2.7, "frontdoor"),
    win("z", 6.5, -1.6, -1.05, 0.3, 2.7),
    win("z", 6.5, 1.05, 1.6, 0.3, 2.7),
    win("z", 6.5, -1.6, 1.6, 3.45, 5.75),
    door("x", 2.5, 2.2, 5.0, F1, 2.7),
    door("z", -1, -1.3, 1.3, F1, 2.6),
    door("x", -2.5, -0.75, 0.55, F1, 2.35, "door"),
    door("z", 0.5, 4.2, 7.6, F1, 2.7),
    door("x", 2.5, -5.0, -2.2, F1, 2.7),
    win("z", 6.5, 3.3, 5.3, 0.45, 2.7),
    win("z", 6.5, 6.2, 8.2, 0.45, 2.7),
    win("z", -6.5, 3.6, 5.4, 0.6, 2.7),
    win("z", -6.5, 6.1, 7.9, 0.6, 2.7),
    win("x", 9, -4.4, -2.0, 0.6, 2.7),
    win("z", -6.5, -2.9, -0.9, 1.15, 2.55),
    win("z", -6.5, -7.4, -5.6, 0.6, 2.7),
    win("x", -8, -5.2, -2.6, 0.6, 2.7),
    win("z", 6.5, -7.2, -5.6, 0.6, 2.7),
    win("z", 6.5, -4.9, -3.3, 0.6, 2.7),
    win("x", -8, 1.8, 4.2, 0.6, 2.7),
    // --- Upper level ---
    win("x", -8, -0.7, 0.3, F2 + 0.6, F2 + 2.5),
    door("x", 2.5, -0.9, 0.5, F2, 2.4, "door"),
    door("z", -1.5, 7.2, 8.4, F2, 2.3, "door"),
    door("z", 0.8, -5.3, -4.3, F2, 2.3, "door"),
    door("z", -1.2, -5.3, -4.3, F2, 2.3, "door"),
    win("z", 6.5, 3.4, 5.4, F2 + 0.45, F2 + 2.65),
    win("z", 6.5, 6.0, 8.0, F2 + 0.45, F2 + 2.65),
    win("z", -6.5, 4.8, 6.8, F2 + 0.95, F2 + 2.6),
    win("z", 6.5, -7.1, -5.5, F2 + 0.6, F2 + 2.6),
    win("z", 6.5, -4.8, -3.2, F2 + 0.6, F2 + 2.6),
    win("z", -6.5, -7.0, -5.4, F2 + 0.6, F2 + 2.6),
    win("x", -8, -4.6, -2.6, F2 + 0.6, F2 + 2.6),
  ];
}

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0.01;

function openingsFor(openings, plane, at, from, to, y0, y1) {
  return openings
    .filter((o) => o.plane === plane && Math.abs(o.at - at) < 1e-3 && overlap(o.span[0], o.span[1], from, to) && overlap(o.y[0], o.y[1], y0, y1))
    .map((o) => ({ a: o.span[0], b: o.span[1], y0: o.y[0], y1: Math.min(o.y[1], y1), kind: o.kind === "frontdoor" ? "door" : o.kind }));
}

function sideRun(room, side) {
  const [x0, x1, z0, z1] = room.rect;
  switch (side) {
    case "n":
      return { axis: "x", plane: "z", at: z0, from: x0, to: x1, side: 1 };
    case "s":
      return { axis: "x", plane: "z", at: z1, from: x0, to: x1, side: -1 };
    case "w":
      return { axis: "z", plane: "x", at: x0, from: z0, to: z1, side: 1 };
    default:
      return { axis: "z", plane: "x", at: x1, from: z0, to: z1, side: -1 };
  }
}

function buildRoomShell(b, M, room, openings, windowMats) {
  const [x0, x1, z0, z1] = room.rect;
  b.box(room.floorMat, [x0, room.y0 - 0.06, z0], [x1, room.y0, z1]);
  const ceilings = room.ceiling || [[x0, x1, z0, z1]];
  for (const [cx0, cx1, cz0, cz1] of ceilings) b.box(M.ceiling, [cx0, room.y1, cz0], [cx1, room.y1 + 0.06, cz1]);
  if (room.y0 > 0) {
    // Structural slab below upper rooms (visible only at the stair opening).
    b.box(M.ceiling, [x0, room.y0 - 0.3, z0], [x1, room.y0 - 0.06, z1]);
  }
  for (const s of ["n", "s", "w", "e"]) {
    if (room.skip && room.skip.includes(s)) continue;
    const run = sideRun(room, s);
    const ext = room.ext.includes(s);
    buildWallRun(b, {
      ...run,
      y0: room.y0,
      y1: room.y1,
      t: ext ? EXT_T : INT_T,
      mat: room.wall,
      trim: room.trim,
      openings: openingsFor(openings, run.plane, run.at, run.from, run.to, room.y0, room.y1),
      window: windowMats,
    });
  }
}

function buildEntryVoid(b, M, openings, windowMats) {
  // Double-height foyer: walls from the main ceiling line up to the roof.
  const y0 = H1;
  const y1 = H2;
  const runs = [
    { axis: "x", plane: "z", at: 6.5, from: -2.5, to: 2.5, side: -1, t: EXT_T },
    { axis: "z", plane: "x", at: 2.5, from: 0.8, to: 6.5, side: -1, t: INT_T },
    { axis: "z", plane: "x", at: -2.5, from: 0.8, to: 6.5, side: 1, t: INT_T },
  ];
  for (const run of runs) {
    buildWallRun(b, {
      ...run,
      y0,
      y1,
      mat: M.wall,
      trim: null,
      openings: openingsFor(openings, run.plane, run.at, run.from, run.to, y0, y1),
      window: windowMats,
    });
  }
  // Belt molding where the main-level wall ends.
  b.box(M.trim, [-2.5 + INT_T, H1 - 0.04, 0.8], [-2.5 + INT_T + 0.03, H1 + 0.06, 6.5 - EXT_T]);
  b.box(M.trim, [2.5 - INT_T - 0.03, H1 - 0.04, 0.8], [2.5 - INT_T, H1 + 0.06, 6.5 - EXT_T]);
  // Void ceiling + slab fascia at the landing edge.
  b.box(M.ceiling, [-2.5, H2, 0.8], [2.5, H2 + 0.06, 6.5]);
  b.box(M.trim, [-1.25, H1, 0.76], [2.5, F2, 0.84]);
  // Crown molding around the void.
  b.box(M.trim, [-2.5 + INT_T, H2 - 0.1, 0.8], [-2.5 + INT_T + 0.03, H2, 6.5]);
  b.box(M.trim, [2.5 - INT_T - 0.03, H2 - 0.1, 0.8], [2.5 - INT_T, H2, 6.5]);
  b.box(M.trim, [-2.5, H2 - 0.1, 6.5 - EXT_T - 0.03], [2.5, H2, 6.5 - EXT_T]);
}

function buildUpperHallSouthWall(b, M, openings, windowMats) {
  const run = { axis: "x", plane: "z", at: 0.8, from: -8, to: -2.5, side: -1 };
  buildWallRun(b, {
    ...run,
    y0: F2,
    y1: H2,
    t: INT_T,
    mat: M.wall,
    trim: M.trim,
    openings: openingsFor(openings, run.plane, run.at, run.from, run.to, F2, H2),
    window: windowMats,
  });
}

// Stairs: straight run along the foyer's west wall, rising toward -z.
const STAIR = { x0: -2.425, x1: -1.25, zBottom: 5.6, steps: 18, run: 0.27 };

function buildStairs(b, M) {
  const rise = F2 / STAIR.steps;
  const { x0, x1, zBottom, run, steps } = STAIR;
  for (let i = 0; i < steps; i++) {
    const top = (i + 1) * rise;
    const za = zBottom - (i + 1) * run;
    const zb = zBottom - i * run;
    b.box(M.trim, [x0, 0, za], [x1, top - 0.035, zb]);
    b.box(M.oak, [x0, top - 0.035, za], [x1 + 0.02, top, zb + 0.025]);
  }
  // Handrail + balusters on the open side.
  const zTop = zBottom - steps * run;
  const len = Math.hypot(zBottom - zTop, F2);
  const ang = Math.atan2(F2, zBottom - zTop);
  const midZ = (zBottom + zTop) / 2;
  b.add(M.walnut, boxGeom(0.06, 0.05, len + 0.2), [x1 + 0.02, F2 / 2 + 0.92, midZ], [ang, 0, 0]);
  for (let i = 0; i < steps; i++) {
    for (const f of [0.25, 0.75]) {
      const z = zBottom - (i + f) * run;
      const tread = (i + 1) * rise;
      const railY = ((zBottom - z) / (zBottom - zTop)) * F2 + 0.9;
      b.box(M.blackMetal, [x1 + 0.005, tread, z - 0.008], [x1 + 0.03, railY, z + 0.008]);
    }
  }
  b.box(M.walnut, [x1 - 0.03, 0, zBottom - 0.08], [x1 + 0.08, 1.05, zBottom + 0.03]);

  // Landing railing along the void edge (z = 0.8).
  b.box(M.walnut, [x1, F2 + 0.95, 0.77], [2.5 - INT_T, F2 + 1.0, 0.85]);
  for (let x = x1 + 0.06; x < 2.5 - INT_T; x += 0.13) {
    b.box(M.blackMetal, [x - 0.008, F2, 0.8], [x + 0.008, F2 + 0.95, 0.82]);
  }
}

function boxGeom(w, h, d) {
  return new THREE.BoxGeometry(w, h, d);
}

// ---------------------------------------------------------------------------
// Furnishing
// ---------------------------------------------------------------------------

function furnishEntry(b, M) {
  // Front doors (walnut, double) set into the opening.
  const z = 6.5 - 0.12;
  for (const s of [-1, 1]) {
    const xa = s < 0 ? -0.9 : 0.004;
    const xb = s < 0 ? -0.004 : 0.9;
    b.box(M.doorWood, [xa, 0, z - 0.03], [xb, 2.7, z + 0.03]);
    for (const [ya, yb] of [
      [0.25, 1.2],
      [1.4, 2.5],
    ]) {
      b.box(M.doorWood, [xa + 0.12, ya, z - 0.045], [xb - 0.12, yb, z - 0.03]);
    }
    b.box(M.brass, [s * 0.09 - 0.012, 0.85, z - 0.09], [s * 0.09 + 0.012, 1.55, z - 0.07]);
  }
  F.chandelier(b, M, { pos: [0.2, 4.55, 3.6], ceilingY: H2, r: 0.6, tiers: 2 });
  b.light({ position: [0.2, 4.4, 3.6], intensity: 26, range: 11, name: "Entry_Chandelier" });
  F.roundTable(b, M, { pos: [0.35, 0, 3.6], r: 0.62, h: 0.76, top: M.walnut, base: M.walnutDark });
  F.vase(b, M, { pos: [0.35, 0.76, 3.6], mat: M.ceramicDark, seed: 4 });
  b.cbox(M.ceramic, [0.75, 0.81, 3.4], [0.22, 0.1, 0.28]);
  F.art(b, M, { pos: [2.5 - INT_T, 4.55, 3.6], rotY: -Math.PI / 2, w: 2.2, h: 1.1, canvas: M.artLake, frame: M.walnutDark });
  // Bench + mirror on the east wall near the door.
  b.rbox(M.leather, [2.15, 0.45, 5.7], [0.4, 0.08, 1.1], 0.03);
  b.box(M.blackMetal, [1.98, 0, 5.2], [2.32, 0.42, 5.23]);
  b.box(M.blackMetal, [1.98, 0, 6.17], [2.32, 0.42, 6.2]);
  F.shadow(b, M, [2.15, 0, 5.7], 0.4, 1.1);
  b.box(M.brass, [2.5 - INT_T - 0.03, 1.0, 5.25], [2.5 - INT_T, 2.3, 6.15]);
  b.box(M.mirror, [2.5 - INT_T - 0.035, 1.03, 5.28], [2.5 - INT_T - 0.03, 2.27, 6.12]);
  F.plant(b, M, { pos: [-0.95, 0, 0.0], height: 1.7, pot: "ceramicDark", seed: 12 });
  b.light({ position: [0, 2.7, -0.1], intensity: 6, range: 5, name: "Entry_Hall" });
  F.rugAt(b, M, { pos: [0.3, 0, 1.9], w: 1.4, d: 2.6, mat: M.rugBlue });
}

function furnishLiving(b, M) {
  const wallX = 9 - EXT_T;
  // Chimney breast with a recessed firebox and a travertine surround.
  const front = 8.4;
  b.box(M.wall, [front, 0, 2.3], [wallX, H1, 3.05]);
  b.box(M.wall, [front, 0, 3.95], [wallX, H1, 4.7]);
  b.box(M.wall, [front, 0.98, 3.05], [wallX, H1, 3.95]);
  b.box(M.firebox, [8.58, 0.14, 3.05], [wallX, 0.98, 3.95]);
  b.box(M.firebox, [front, 0.14, 3.05], [8.58, 0.16, 3.95]);
  b.box(M.firebox, [front, 0.14, 3.05], [8.58, 0.98, 3.07]);
  b.box(M.firebox, [front, 0.14, 3.93], [8.58, 0.98, 3.95]);
  b.box(M.firebox, [front, 0.96, 3.05], [8.58, 0.98, 3.95]);
  b.box(M.travertine, [8.34, 0, 2.7], [front, 1.3, 3.05]);
  b.box(M.travertine, [8.34, 0, 3.95], [front, 1.3, 4.3]);
  b.box(M.travertine, [8.34, 0.98, 3.05], [front, 1.3, 3.95]);
  b.box(M.travertine, [7.95, 0, 2.7], [8.34, 0.08, 4.3]);
  b.box(M.travertine, [front, 0, 3.05], [8.58, 0.14, 3.95]);
  for (const dz of [-0.18, 0.18]) b.cyl(M.ember, [8.64, 0.24, 3.5 + dz], 0.06, 0.06, 0.62, 10, [0, 0, Math.PI / 2 - 0.05]);
  for (const [dz, s] of [
    [-0.2, 0.9],
    [0.0, 1.2],
    [0.22, 0.85],
  ]) {
    b.sphere(M.fire, [8.64, 0.42 + 0.06 * s, 3.5 + dz], 0.09, [0.6, 1.9 * s, 1.1], 1);
  }
  b.light({ position: [8.2, 0.55, 3.5], color: "#ff9a52", intensity: 3, range: 4.5, name: "Living_Fire" });
  F.art(b, M, { pos: [front, 2.05, 3.5], rotY: -Math.PI / 2, w: 1.55, h: 0.78, canvas: M.artLake, frame: M.brass });

  // Built-in shelving flanking the fireplace.
  for (const [za, zb] of [
    [0.6, 2.3],
    [4.7, 6.28],
  ]) {
    b.box(M.cabinet, [8.4, 0, za], [wallX, 0.85, zb]);
    b.box(M.trim, [8.38, 0.85, za], [wallX, 0.89, zb]);
    for (const y of [1.45, 2.05]) b.box(M.trim, [8.48, y, za], [wallX, y + 0.035, zb]);
    const zc = (za + zb) / 2;
    b.sphere(M.ceramic, [8.6, 1.02, zc - 0.35], 0.12, [1, 1.1, 1]);
    for (let i = 0; i < 9; i++) b.box(M.books[i % M.books.length], [8.5, 1.485, zc + 0.05 + i * 0.035], [8.75, 1.485 + 0.22 + (i % 3) * 0.03, zc + 0.08 + i * 0.035]);
    b.cyl(M.ceramicDark, [8.62, 2.18, zc], 0.08, 0.1, 0.22, 20);
  }

  F.sofa(b, M, { pos: [4.45, 0, 3.6], rotY: Math.PI / 2, length: 2.9, depth: 1.0, mat: M.sofa, pillow: M.sage });
  F.loungeChair(b, M, { pos: [7.05, 0, 1.75], rotY: -0.55, mat: M.velvetNavy });
  F.loungeChair(b, M, { pos: [7.05, 0, 5.45], rotY: -2.6, mat: M.velvetNavy });
  F.coffeeTable(b, M, { pos: [6.15, 0, 3.6], r: 0.58, h: 0.38, mat: M.travertine });
  b.cbox(M.books[1], [6.0, 0.4, 3.45], [0.3, 0.04, 0.22]);
  b.cbox(M.books[2], [6.0, 0.435, 3.45], [0.26, 0.03, 0.2]);
  F.vase(b, M, { pos: [6.35, 0.38, 3.75], mat: M.ceramic, seed: 8 });
  F.rugAt(b, M, { pos: [6.0, 0, 3.6], w: 3.8, d: 4.6, mat: M.rugLiving });
  // Console behind the sofa with lamps.
  F.rectTable(b, M, { pos: [3.62, 0, 3.6], rotY: Math.PI / 2, w: 2.0, d: 0.38, h: 0.74, top: M.walnut });
  F.tableLamp(b, M, [3.62, 0.74, 2.9]);
  F.tableLamp(b, M, [3.62, 0.74, 4.3]);
  F.floorLamp(b, M, { pos: [4.55, 0, 5.55] });
  F.plant(b, M, { pos: [8.2, 0, 6.0], height: 1.9, seed: 21 });
  F.plant(b, M, { pos: [3.05, 0, 1.0], height: 1.4, pot: "ceramicDark", seed: 22 });
  // Drapes.
  for (const [xa, xb] of [
    [3.3, 5.3],
    [6.2, 8.2],
  ]) {
    F.drape(b, M, { pos: [xa - 0.12, 0, 6.5 - EXT_T - 0.09], rotY: Math.PI, w: 0.42, h: H1 - 0.12 });
    F.drape(b, M, { pos: [xb + 0.12, 0, 6.5 - EXT_T - 0.09], rotY: Math.PI, w: 0.42, h: H1 - 0.12 });
  }
  b.light({ position: [4.6, 2.75, 3.5], intensity: 14, range: 8, name: "Living_A" });
  b.light({ position: [7.3, 2.75, 3.5], intensity: 14, range: 8, name: "Living_B" });
}

function furnishDining(b, M) {
  const cx = 5.75;
  const cz = -3.2;
  F.rugAt(b, M, { pos: [cx, 0, cz], w: 3.1, d: 4.4, mat: M.rugDining });
  F.rectTable(b, M, { pos: [cx, 0, cz], w: 1.1, d: 2.8, h: 0.76, top: M.walnut, legs: M.walnutDark });
  for (const dz of [-0.85, 0, 0.85]) {
    F.diningChair(b, M, { pos: [cx - 0.82, 0, cz + dz], rotY: Math.PI / 2, mat: M.linenTaupe });
    F.diningChair(b, M, { pos: [cx + 0.82, 0, cz + dz], rotY: -Math.PI / 2, mat: M.linenTaupe });
  }
  F.diningChair(b, M, { pos: [cx, 0, cz - 1.72], rotY: 0, mat: M.velvetNavy });
  F.diningChair(b, M, { pos: [cx, 0, cz + 1.72], rotY: Math.PI, mat: M.velvetNavy });
  F.globeChandelier(b, M, { pos: [cx, 2.1, cz], ceilingY: H1, length: 1.7 });
  b.light({ position: [cx, 1.85, cz], intensity: 16, range: 7, name: "Dining_Chandelier" });
  // Table setting.
  for (const dz of [-0.85, 0, 0.85]) {
    for (const s of [-1, 1]) b.cyl(M.porcelain, [cx + s * 0.33, 0.765, cz + dz], 0.13, 0.12, 0.015, 28);
  }
  F.vase(b, M, { pos: [cx, 0.76, cz], mat: M.ceramic, seed: 31 });
  // Sideboard + art.
  b.rbox(M.walnut, [2.86, 0.42, -0.85], [0.45, 0.76, 1.8], 0.015);
  for (const dz of [-0.6, 0, 0.6]) b.box(M.walnutDark, [3.085, 0.12, -0.85 + dz - 0.28], [3.09, 0.76, -0.85 + dz + 0.28]);
  F.shadow(b, M, [2.86, 0, -0.85], 0.45, 1.8);
  F.tableLamp(b, M, [2.85, 0.8, -1.5], 0.9);
  b.cyl(M.ceramicDark, [2.85, 0.91, -0.3], 0.07, 0.09, 0.22, 20);
  F.art(b, M, { pos: [2.5 + INT_T, 1.85, -0.85], rotY: Math.PI / 2, w: 1.0, h: 1.0, canvas: M.artCircles, frame: M.walnutDark });
  F.plant(b, M, { pos: [8.35, 0, -5.9], height: 1.8, seed: 33 });
  for (const [xa, xb] of [
    [3.6, 5.4],
    [6.1, 7.9],
  ]) {
    F.drape(b, M, { pos: [xa - 0.12, 0, -6.5 + EXT_T + 0.09], rotY: 0, w: 0.36, h: H1 - 0.12 });
    F.drape(b, M, { pos: [xb + 0.12, 0, -6.5 + EXT_T + 0.09], rotY: 0, w: 0.36, h: H1 - 0.12 });
  }
}

function furnishKitchen(b, M) {
  const back = -6.5 + EXT_T;
  const depth = 0.62;
  // Tall pantry / refrigerator column.
  b.box(M.cabinet, [-5.0, 0, back], [-3.6, 2.45, back + depth + 0.02]);
  b.box(M.trim, [-5.0, 2.45, back], [-3.6, H1, back + depth]);
  for (const x of [-4.3]) b.box(M.blackMetal, [x - 0.003, 0.02, back + depth + 0.02], [x + 0.003, 2.43, back + depth + 0.025]);
  for (const x of [-4.36, -4.24]) b.box(M.brass, [x - 0.01, 0.9, back + depth + 0.03], [x + 0.01, 1.7, back + depth + 0.05]);
  // Base run.
  b.box(M.ceramicDark, [-3.6, 0, back], [2.3, 0.1, back + depth - 0.06]);
  b.box(M.cabinet, [-3.6, 0.1, back], [2.3, 0.9, back + depth]);
  const doors = [-3.6, -2.95, -2.3, -1.5, -0.8, -0.15, 0.25, 1.15, 1.7, 2.3];
  for (let i = 0; i < doors.length - 1; i++) {
    const xa = doors[i];
    const xb = doors[i + 1];
    if (xa >= 0.25 && xb <= 1.15) continue;
    b.box(M.cabinet, [xa + 0.012, 0.13, back + depth], [xb - 0.012, 0.87, back + depth + 0.02]);
    b.box(M.brass, [(xa + xb) / 2 - 0.08, 0.76, back + depth + 0.02], [(xa + xb) / 2 + 0.08, 0.775, back + depth + 0.04]);
  }
  b.box(M.marble, [-3.62, 0.9, back], [2.32, 0.94, back + depth + 0.03]);
  // Backsplash: marble slab to the window sill and full height behind the range.
  b.box(M.marble, [-3.6, 0.94, back], [2.3, 1.15, back + 0.02]);
  b.box(M.marble, [-0.9, 1.15, back], [2.3, H1, back + 0.02]);
  b.box(M.marble, [-3.6, 1.15, back], [-2.9, H1, back + 0.02]);
  // Sink + faucet under the window.
  b.box(M.steel, [-2.3, 0.86, back + 0.12], [-1.5, 0.945, back + 0.5]);
  b.cyl(M.brass, [-1.9, 1.1, back + 0.08], 0.015, 0.018, 0.32, 12);
  b.cyl(M.brass, [-1.9, 1.25, back + 0.17], 0.013, 0.013, 0.2, 12, [Math.PI / 2, 0, 0]);
  // Range + plaster hood.
  b.box(M.steel, [0.25, 0.1, back], [1.15, 0.92, back + depth + 0.01]);
  b.box(M.granite, [0.25, 0.92, back], [1.15, 0.96, back + depth]);
  for (const dx of [0.42, 0.7, 0.98]) b.cyl(M.blackMetal, [dx, 0.97, back + 0.32], 0.08, 0.08, 0.015, 16);
  for (const dx of [0.35, 0.55, 0.85, 1.05]) b.cyl(M.blackMetal, [dx, 0.8, back + depth + 0.02], 0.022, 0.022, 0.04, 12, [Math.PI / 2, 0, 0]);
  b.box(M.wall, [0.05, 1.85, back], [1.35, H1, back + 0.55]);
  b.box(M.wall, [0.15, 1.65, back], [1.25, 1.85, back + 0.5]);
  b.box(M.brass, [0.05, 1.85, back + 0.55], [1.35, 1.9, back + 0.56]);
  // Floating walnut shelves.
  for (const [xa, xb] of [
    [-0.75, -0.05],
    [1.45, 2.25],
  ]) {
    for (const y of [1.55, 1.95]) {
      b.box(M.walnut, [xa, y, back], [xb, y + 0.045, back + 0.28]);
      for (let k = 0; k < 4; k++) b.cyl(M.porcelain, [xa + 0.12 + k * 0.035, y + 0.045 + 0.11, back + 0.15], 0.11, 0.11, 0.01, 20, [0, 0, Math.PI / 2]);
      b.cyl(M.ceramic, [xb - 0.15, y + 0.12, back + 0.14], 0.06, 0.06, 0.15, 16);
    }
  }
  // Island.
  const ix = -1.4;
  const iz = -3.65;
  b.box(M.cabinetGreen, [ix - 1.7, 0.1, iz - 0.58], [ix + 1.7, 0.9, iz + 0.42]);
  b.box(M.ceramicDark, [ix - 1.65, 0, iz - 0.53], [ix + 1.65, 0.1, iz + 0.37]);
  for (let i = 0; i < 4; i++) {
    const xa = ix - 1.7 + i * 0.85;
    b.box(M.cabinetGreen, [xa + 0.015, 0.13, iz - 0.6], [xa + 0.835, 0.87, iz - 0.58]);
    b.box(M.brass, [xa + 0.35, 0.78, iz - 0.62], [xa + 0.5, 0.795, iz - 0.6]);
  }
  b.box(M.marble, [ix - 1.8, 0.9, iz - 0.62], [ix + 1.8, 0.95, iz + 0.62]);
  b.box(M.marble, [ix - 1.8, 0, iz - 0.62], [ix - 1.75, 0.9, iz + 0.62]);
  b.box(M.marble, [ix + 1.75, 0, iz - 0.62], [ix + 1.8, 0.9, iz + 0.62]);
  F.shadow(b, M, [ix, 0, iz], 3.6, 1.24);
  for (const dx of [-1.15, -0.4, 0.35, 1.1]) F.stool(b, M, { pos: [ix + dx, 0, iz + 0.95], rotY: Math.PI, mat: M.leather });
  for (const dx of [-1.1, 0, 1.1]) F.pendant(b, M, { pos: [ix + dx, 2.05, iz], ceilingY: H1, r: 0.19, mat: M.brass });
  b.light({ position: [ix, 1.9, iz], intensity: 16, range: 7, name: "Kitchen_Island" });
  b.cyl(M.ceramic, [ix + 0.6, 1.0, iz - 0.1], 0.2, 0.12, 0.1, 24);
  for (let i = 0; i < 5; i++) b.sphere(M.fruit, [ix + 0.6 + Math.cos(i * 1.3) * 0.08, 1.07 + (i % 2) * 0.03, iz - 0.1 + Math.sin(i * 1.3) * 0.08], 0.045, [1, 0.85, 1], 1);
  F.vase(b, M, { pos: [ix - 0.9, 0.95, iz - 0.05], mat: M.ceramicDark, seed: 41 });
  // Breakfast nook.
  const nx = -6.35;
  const nz = -3.9;
  F.roundTable(b, M, { pos: [nx, 0, nz], r: 0.62, h: 0.75, top: M.walnut, base: M.blackMetal });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    F.diningChair(b, M, { pos: [nx + Math.cos(a) * 0.85, 0, nz + Math.sin(a) * 0.85], rotY: Math.atan2(-Math.cos(a), -Math.sin(a)), mat: M.sage });
  }
  F.pendant(b, M, { pos: [nx, 1.95, nz], ceilingY: H1, r: 0.28, mat: M.blackMetal });
  b.light({ position: [nx, 1.8, nz], intensity: 9, range: 6, name: "Kitchen_Nook" });
  F.plant(b, M, { pos: [-7.5, 0, -1.55], height: 1.6, seed: 43 });
  b.light({ position: [-2.0, 2.75, -2.0], intensity: 8, range: 7, name: "Kitchen_Fill" });
}

function furnishOffice(b, M) {
  F.rugAt(b, M, { pos: [-5.1, 0, 3.0], w: 3.0, d: 4.0, mat: M.rugOffice });
  // Desk in front of the west window, facing into the room.
  const dx = -6.7;
  const dz = 3.0;
  b.group([dx, 0, dz], Math.PI / 2, () => {
    b.rbox(M.walnut, [0, 0.745, 0], [1.9, 0.05, 0.85], 0.01);
    b.box(M.walnutDark, [-0.93, 0, -0.4], [-0.55, 0.72, 0.4]);
    b.box(M.walnutDark, [0.55, 0, -0.4], [0.93, 0.72, 0.4]);
    b.box(M.walnutDark, [-0.55, 0.6, 0.38], [0.55, 0.72, 0.4]);
    for (const x of [-0.74, 0.74]) for (const y of [0.2, 0.45]) b.box(M.brass, [x - 0.06, y, 0.4], [x + 0.06, y + 0.012, 0.42]);
    b.cbox(M.blackMetal, [0.15, 0.79, -0.15], [0.42, 0.012, 0.3]);
    b.cbox(M.books[3], [-0.55, 0.8, 0.05], [0.24, 0.05, 0.3]);
  });
  F.shadow(b, M, [dx, 0, dz], 0.85, 1.9);
  // Brass desk lamp.
  b.cyl(M.brass, [dx - 0.1, 0.78, dz + 0.72], 0.08, 0.08, 0.02, 20);
  b.cyl(M.brass, [dx - 0.1, 0.98, dz + 0.72], 0.01, 0.01, 0.4, 8);
  b.cyl(M.brass, [dx - 0.1, 1.2, dz + 0.72], 0.05, 0.14, 0.12, 24);
  b.cyl(M.bulb, [dx - 0.1, 1.14, dz + 0.72], 0.12, 0.12, 0.005, 20);
  F.loungeChair(b, M, { pos: [dx - 0.75, 0, dz], rotY: Math.PI / 2, mat: M.leather, legs: M.blackMetal });
  // Leather sofa against the east wall + art.
  F.sofa(b, M, { pos: [-3.05, 0, 3.2], rotY: -Math.PI / 2, length: 2.3, depth: 0.95, mat: M.leather, pillow: M.rust });
  F.art(b, M, { pos: [-2.5 - INT_T, 1.75, 3.2], rotY: -Math.PI / 2, w: 0.9, h: 1.15, canvas: M.artLines, frame: M.brass });
  F.coffeeTable(b, M, { pos: [-4.4, 0, 3.2], r: 0.45, h: 0.42, mat: M.walnutDark });
  b.cbox(M.books[0], [-4.4, 0.44, 3.15], [0.28, 0.04, 0.2]);
  // Full-height library wall.
  F.bookshelf(b, M, { pos: [-5.2, 0, -1 + INT_T + 0.19], rotY: 0, w: 4.8, h: 2.8, d: 0.38, shelves: 6, frame: M.walnutDark, seed: 19, fill: 0.82 });
  b.light({ position: [-5.2, 2.6, 0.2], intensity: 4, range: 4, name: "Office_Shelves" });
  F.floorLamp(b, M, { pos: [-7.5, 0, 5.9] });
  F.plant(b, M, { pos: [-3.0, 0, 6.0], height: 1.5, pot: "ceramicDark", seed: 51 });
  b.light({ position: [-5.2, 2.75, 3.0], intensity: 12, range: 7, name: "Office" });
  for (const [xa, xb] of [
    [-7.2, -5.6],
    [-4.9, -3.3],
  ]) {
    F.drape(b, M, { pos: [xa - 0.1, 0, 6.5 - EXT_T - 0.09], rotY: Math.PI, w: 0.32, h: H1 - 0.12 });
    F.drape(b, M, { pos: [xb + 0.1, 0, 6.5 - EXT_T - 0.09], rotY: Math.PI, w: 0.32, h: H1 - 0.12 });
  }
}

function furnishLanding(b, M) {
  // Bench + art on the hall wall opposite the railing.
  b.rbox(M.linenTaupe, [0.4, F2 + 0.45, -0.95], [1.5, 0.1, 0.42], 0.03);
  for (const x of [-0.25, 1.05]) b.box(M.walnutDark, [x - 0.02, F2, -1.1], [x + 0.02, F2 + 0.42, -0.8]);
  F.shadow(b, M, [0.4, F2, -0.95], 1.5, 0.42);
  F.art(b, M, { pos: [0.4, F2 + 1.6, -1.2 + INT_T], rotY: 0, w: 1.3, h: 1.0, canvas: M.artField, frame: M.walnutDark });
  F.plant(b, M, { pos: [-7.5, F2, -0.85], height: 1.3, seed: 61 });
  F.rugAt(b, M, { pos: [-4.4, F2, -0.2], w: 4.6, d: 1.0, mat: M.rugBlue });
  for (const x of [-5.6, -2.6, 1.0]) {
    b.cyl(M.brass, [x, H2 - 0.03, -0.2], 0.2, 0.2, 0.04, 24);
    b.cyl(M.globe, [x, H2 - 0.07, -0.2], 0.17, 0.18, 0.05, 24);
  }
  b.light({ position: [-2.6, H2 - 0.4, -0.2], intensity: 9, range: 7, name: "Landing_A" });
  b.light({ position: [-6.0, H2 - 0.4, -0.2], intensity: 5, range: 5, name: "Landing_B" });
}

function furnishPrimary(b, M) {
  const wallX = 9 - EXT_T;
  const bz = 2.5;
  F.rugAt(b, M, { pos: [7.0, F2, bz], w: 3.2, d: 3.6, mat: M.rugBed });
  // Upholstered wall panel behind the bed.
  b.rbox(M.linenTaupe, [wallX - 0.04, F2 + 1.35, bz], [0.08, 2.1, 3.4], 0.03);
  F.bed(b, M, { pos: [7.6, F2, bz], rotY: -Math.PI / 2, width: 2.0, length: 2.15, frame: M.linenTaupe, headboard: M.linenTaupe, duvet: M.duvet, sheet: M.linen, pillows: M.sage, throwMat: M.velvetNavy });
  for (const s of [-1, 1]) {
    F.nightstand(b, M, { pos: [8.45, F2, bz + s * 1.38], rotY: -Math.PI / 2, mat: M.walnut });
    b.light({ position: [8.45, F2 + 1.1, bz + s * 1.38], intensity: 2.2, range: 3, name: `Primary_Lamp_${s}` });
  }
  b.rbox(M.velvetNavy, [6.2, F2 + 0.42, bz], [0.45, 0.14, 1.5], 0.04);
  for (const dz of [-0.6, 0.6]) b.box(M.walnutDark, [6.0, F2, bz + dz - 0.02], [6.4, F2 + 0.36, bz + dz + 0.02]);
  // Sitting area by the front windows.
  F.loungeChair(b, M, { pos: [3.6, F2, 5.35], rotY: 2.4, mat: M.linen });
  F.loungeChair(b, M, { pos: [5.0, F2, 5.75], rotY: -2.6, mat: M.linen });
  F.roundTable(b, M, { pos: [4.25, F2, 5.85], r: 0.28, h: 0.5, top: M.travertine, base: M.brass });
  F.floorLamp(b, M, { pos: [3.05, F2, 6.0] });
  // Dresser + mirror on the west wall.
  b.rbox(M.walnut, [2.86, F2 + 0.42, 3.0], [0.5, 0.84, 1.8], 0.015);
  for (const y of [0.2, 0.47, 0.72]) b.box(M.brass, [3.11, F2 + y, 2.6], [3.13, F2 + y + 0.015, 3.4]);
  F.shadow(b, M, [2.86, F2, 3.0], 0.5, 1.8);
  b.box(M.brass, [2.5 + INT_T, F2 + 1.15, 2.45], [2.5 + INT_T + 0.03, F2 + 2.35, 3.55]);
  b.box(M.mirror, [2.5 + INT_T + 0.03, F2 + 1.18, 2.48], [2.5 + INT_T + 0.035, F2 + 2.32, 3.52]);
  F.vase(b, M, { pos: [2.86, F2 + 0.84, 3.6], mat: M.ceramic, seed: 71 });
  F.plant(b, M, { pos: [8.4, F2, 6.05], height: 1.7, seed: 72 });
  F.plant(b, M, { pos: [3.0, F2, -1.0], height: 1.2, pot: "ceramicDark", seed: 73 });
  for (const [xa, xb] of [
    [3.4, 5.4],
    [6.0, 8.0],
  ]) {
    F.drape(b, M, { pos: [xa - 0.12, F2, 6.5 - EXT_T - 0.09], rotY: Math.PI, w: 0.4, h: H2 - F2 - 0.12 });
    F.drape(b, M, { pos: [xb + 0.12, F2, 6.5 - EXT_T - 0.09], rotY: Math.PI, w: 0.4, h: H2 - F2 - 0.12 });
  }
  b.light({ position: [5.75, H2 - 0.35, 2.5], intensity: 12, range: 8, name: "Primary" });
}

function furnishPrimaryBath(b, M) {
  const wallX = 9 - EXT_T;
  const back = -6.5 + EXT_T;
  // Freestanding tub under the window.
  b.rbox(M.porcelain, [5.8, F2 + 0.3, -5.5], [1.75, 0.6, 0.85], 0.24, 0, 4);
  b.rbox(M.water, [5.8, F2 + 0.52, -5.5], [1.5, 0.08, 0.62], 0.2, 0, 3);
  F.shadow(b, M, [5.8, F2, -5.5], 1.75, 0.85);
  b.cyl(M.brass, [6.85, F2 + 0.45, -5.5], 0.02, 0.025, 0.9, 12);
  b.cyl(M.brass, [6.75, F2 + 0.88, -5.5], 0.015, 0.015, 0.2, 10, [0, 0, Math.PI / 2]);
  b.cbox(M.duvet, [4.75, F2 + 0.6, -5.5], [0.06, 0.25, 0.35]);
  // Double vanity on the west wall.
  const vx = 2.5 + INT_T;
  b.box(M.walnut, [vx, F2 + 0.15, -5.0], [vx + 0.58, F2 + 0.85, -2.4]);
  b.box(M.ceramicDark, [vx, F2, -4.95], [vx + 0.5, F2 + 0.15, -2.45]);
  b.box(M.marble, [vx, F2 + 0.85, -5.02], [vx + 0.6, F2 + 0.9, -2.38]);
  for (const z of [-4.25, -3.15]) {
    b.rbox(M.porcelain, [vx + 0.34, F2 + 0.96, z], [0.42, 0.12, 0.34], 0.05, 0, 3);
    b.rbox(M.water, [vx + 0.34, F2 + 1.015, z], [0.34, 0.02, 0.26], 0.01);
    b.cyl(M.brass, [vx + 0.06, F2 + 1.05, z], 0.012, 0.015, 0.3, 10);
    b.cyl(M.brass, [vx + 0.14, F2 + 1.18, z], 0.01, 0.01, 0.16, 10, [0, 0, Math.PI / 2]);
    b.box(M.brass, [vx, F2 + 1.3, z - 0.42], [vx + 0.03, F2 + 2.35, z + 0.42]);
    b.box(M.mirror, [vx + 0.03, F2 + 1.33, z - 0.39], [vx + 0.035, F2 + 2.32, z + 0.39]);
    b.cyl(M.brass, [vx + 0.08, F2 + 1.95, z - 0.55], 0.03, 0.03, 0.05, 12, [0, 0, Math.PI / 2]);
    b.cyl(M.globe, [vx + 0.14, F2 + 1.95, z - 0.55], 0.06, 0.06, 0.18, 16);
  }
  b.box(M.walnutDark, [vx + 0.58, F2 + 0.2, -4.98], [vx + 0.6, F2 + 0.8, -2.42]);
  F.shadow(b, M, [vx + 0.3, F2, -3.7], 0.6, 2.6);
  b.light({ position: [vx + 0.8, F2 + 2.0, -3.7], intensity: 5, range: 4, name: "Bath_Vanity" });
  // Walk-in shower with marble walls and glass.
  const sx = 7.25;
  const sz = -4.2;
  b.box(M.marble, [wallX - 0.02, F2, back], [wallX, F2 + 2.5, sz]);
  b.box(M.marble, [sx, F2, back], [wallX, F2 + 2.5, back + 0.02]);
  b.box(M.marble, [sx, F2 + 0.001, back], [wallX, F2 + 0.02, sz]);
  b.box(M.glass, [sx, F2 + 0.02, back + 0.02], [sx + 0.012, F2 + 2.1, sz]);
  b.box(M.glass, [sx + 0.62, F2 + 0.02, sz - 0.012], [wallX, F2 + 2.1, sz]);
  b.box(M.brass, [sx, F2 + 2.1, back], [sx + 0.012, F2 + 2.12, sz]);
  b.box(M.brass, [sx, F2 + 2.1, sz - 0.012], [wallX, F2 + 2.12, sz]);
  b.cyl(M.brass, [8.05, F2 + 2.25, -5.35], 0.15, 0.15, 0.015, 32);
  b.cyl(M.brass, [8.05, F2 + 2.4, -5.35], 0.012, 0.012, 0.3, 8);
  b.cyl(M.brass, [wallX - 0.02, F2 + 1.1, -5.35], 0.04, 0.04, 0.04, 16, [0, 0, Math.PI / 2]);
  // Towel ladder, bath mat, stool, plant.
  for (const z of [-2.0, -1.72]) b.cyl(M.brass, [8.6, F2 + 0.85, z], 0.012, 0.012, 1.7, 8, [0.12, 0, 0]);
  for (const y of [0.4, 0.8, 1.2]) b.box(M.brass, [8.59, F2 + y, -2.0], [8.61, F2 + y + 0.015, -1.72]);
  b.cbox(M.duvet, [8.6, F2 + 0.95, -1.86], [0.06, 0.5, 0.3]);
  F.rugAt(b, M, { pos: [4.0, F2, -3.7], w: 0.7, d: 1.6, mat: M.rugBlue });
  b.cyl(M.walnut, [4.65, F2 + 0.22, -5.95], 0.17, 0.15, 0.44, 24);
  F.plant(b, M, { pos: [3.1, F2, -5.95], height: 1.2, pot: "ceramicDark", seed: 81 });
  b.light({ position: [5.75, H2 - 0.35, -4.0], intensity: 11, range: 7, name: "Primary_Bath" });
}

function furnishBedroom2(b, M) {
  const wallX = -8 + EXT_T;
  const bz = 3.7;
  F.rugAt(b, M, { pos: [-6.0, F2, bz], w: 2.6, d: 3.2, mat: M.rugBlue });
  F.bed(b, M, { pos: [-6.85, F2, bz], rotY: Math.PI / 2, width: 1.65, length: 2.1, frame: M.walnut, headboard: M.velvetNavy, duvet: M.duvet, sheet: M.linen, pillows: M.linenTaupe, throwMat: M.sage });
  for (const s of [-1, 1]) F.nightstand(b, M, { pos: [wallX + 0.3, F2, bz + s * 1.2], rotY: Math.PI / 2, mat: M.cabinet });
  b.light({ position: [wallX + 0.3, F2 + 1.1, bz - 1.2], intensity: 2, range: 3, name: "Bed2_Lamp" });
  F.art(b, M, { pos: [wallX, F2 + 1.95, bz], rotY: Math.PI / 2, w: 1.1, h: 0.75, canvas: M.artCircles, frame: M.walnut });
  // Desk on the east wall.
  F.rectTable(b, M, { pos: [-2.85, F2, 5.1], rotY: Math.PI / 2, w: 1.3, d: 0.55, h: 0.75, top: M.walnut, legs: M.blackMetal });
  F.diningChair(b, M, { pos: [-3.4, F2, 5.1], rotY: Math.PI / 2, mat: M.sage });
  F.tableLamp(b, M, [-2.8, F2 + 0.75, 5.55], 0.85);
  F.plant(b, M, { pos: [-2.95, F2, 1.35], height: 1.3, seed: 91 });
  b.light({ position: [-5.25, H2 - 0.35, 3.6], intensity: 10, range: 7, name: "Bedroom2" });
}

function furnishBedroom3(b, M) {
  const wallX = -2.5 - INT_T;
  const bz = -3.9;
  F.rugAt(b, M, { pos: [-4.0, F2, bz], w: 2.4, d: 3.0, mat: M.rugBed });
  F.bed(b, M, { pos: [-3.65, F2, bz], rotY: -Math.PI / 2, width: 1.5, length: 2.05, frame: M.cabinet, headboard: M.sage, duvet: M.duvet, sheet: M.linen, pillows: M.rust, throwMat: M.linenTaupe });
  for (const s of [-1, 1]) F.nightstand(b, M, { pos: [wallX - 0.3, F2, bz + s * 1.1], rotY: -Math.PI / 2, mat: M.walnut });
  b.light({ position: [wallX - 0.3, F2 + 1.1, bz + 1.1], intensity: 2, range: 3, name: "Bed3_Lamp" });
  F.art(b, M, { pos: [wallX, F2 + 1.95, bz], rotY: -Math.PI / 2, w: 0.8, h: 1.0, canvas: M.artField, frame: M.walnut });
  // Reading corner + bookshelf.
  F.loungeChair(b, M, { pos: [-7.2, F2, -5.7], rotY: 0.75, mat: M.rust });
  F.floorLamp(b, M, { pos: [-7.55, F2, -4.95] });
  F.bookshelf(b, M, { pos: [-7.78 + 0.18, F2, -1.5 - 0.6], rotY: Math.PI / 2, w: 1.0, h: 1.9, d: 0.34, shelves: 4, frame: M.cabinet, seed: 29, fill: 0.7 });
  b.light({ position: [-5.25, H2 - 0.35, -3.85], intensity: 10, range: 7, name: "Bedroom3" });
}

// ---------------------------------------------------------------------------
// Spatial manifest (what the capture pipeline will eventually emit)
// ---------------------------------------------------------------------------

function lookAt(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return { position: from, yaw: round(yaw), pitch: round(pitch) };
}

const round = (v) => Math.round(v * 1000) / 1000;
const rectPoly = ([x0, x1, z0, z1]) => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

function buildManifest(rooms) {
  const e1 = EYE;
  const e2 = F2 + EYE;
  const waypoints = {
    entry: lookAt([0.95, e1, 5.75], [-0.9, 2.3, 0.2]),
    living: lookAt([3.3, e1, 6.0], [8.4, 1.25, 2.6]),
    dining: lookAt([3.3, e1, 0.05], [7.6, 1.05, -4.9]),
    kitchen: lookAt([2.05, e1, -1.45], [-3.6, 1.0, -5.4]),
    office: lookAt([-3.05, e1, -0.45], [-6.9, 1.15, 4.6]),
    landing: lookAt([1.75, e2, -0.65], [-1.6, F2 + 0.9, 3.8]),
    primary: lookAt([3.2, e2, -0.95], [8.1, F2 + 0.75, 3.9]),
    primaryBath: lookAt([8.15, e2, -2.0], [4.1, F2 + 0.95, -5.85]),
    bedroom2: lookAt([-3.05, e2, 1.35], [-7.6, F2 + 0.8, 4.9]),
    bedroom3: lookAt([-7.05, e2, -1.75], [-2.9, F2 + 0.8, -4.7]),
  };
  const P = (x, y, z) => [x, y, z];
  const links = [
    { from: "entry", to: "living", via: [P(2.0, e1, 3.6), P(3.1, e1, 3.6)] },
    { from: "living", to: "dining", via: [P(5.9, e1, 1.1), P(5.9, e1, -0.1)] },
    { from: "dining", to: "kitchen", via: [P(3.1, e1, -3.6), P(1.9, e1, -3.6)] },
    { from: "entry", to: "kitchen", via: [P(0, e1, -0.4), P(0, e1, -1.6)] },
    { from: "entry", to: "office", via: [P(-0.4, e1, 0.3), P(-2.0, e1, -0.1), P(-3.0, e1, -0.1)] },
    {
      from: "entry",
      to: "landing",
      kind: "stairs",
      via: [P(-1.1, e1, 6.15), P(-1.84, e1 + 0.05, 6.05), P(-1.84, e1 + 0.32, 5.2), P(-1.84, e2 - 0.06, 0.8), P(-1.6, e2, 0.1)],
    },
    { from: "landing", to: "primary", via: [P(2.0, e2, -0.2), P(3.1, e2, -0.2)] },
    { from: "primary", to: "primaryBath", via: [P(7.8, e2, -0.9), P(7.8, e2, -2.1)] },
    { from: "landing", to: "bedroom2", via: [P(-4.8, e2, 0.2), P(-4.8, e2, 1.4)] },
    { from: "landing", to: "bedroom3", via: [P(-4.8, e2, -0.6), P(-4.8, e2, -1.8)] },
  ];
  const stairsPoly = [
    [STAIR.x0, STAIR.zBottom - STAIR.steps * STAIR.run],
    [STAIR.x1, STAIR.zBottom - STAIR.steps * STAIR.run],
    [STAIR.x1, STAIR.zBottom],
    [STAIR.x0, STAIR.zBottom],
  ];
  const outline = rectPoly([-8, 9, -6.5, 6.5]);
  return {
    schema: "atrium.scan-manifest/v1",
    source: { kind: "synthetic", generator: "scripts/generate-demo-property.mjs", note: "Hand-authored stand-in for an iPhone LiDAR/RoomPlan capture." },
    units: "meters",
    upAxis: "y",
    eyeHeight: EYE,
    floors: [
      {
        key: "main",
        name: "Main Level",
        level: 1,
        elevation: F1,
        outline,
        features: [{ type: "stairs", polygon: stairsPoly, direction: "up", treads: STAIR.steps }],
      },
      {
        key: "upper",
        name: "Upper Level",
        level: 2,
        elevation: F2,
        outline,
        features: [
          { type: "stairs", polygon: stairsPoly, direction: "down", treads: STAIR.steps },
          { type: "void", label: "Open to below", polygon: rectPoly([-1.25, 2.5, 0.8, 6.5]) },
        ],
      },
    ],
    rooms: rooms.map((r, i) => ({
      key: r.key,
      name: r.name,
      floor: r.floor,
      order: i,
      footprint: rectPoly(r.rect),
      waypoint: waypoints[r.key],
    })),
    links,
  };
}
