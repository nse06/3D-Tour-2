// The "real" apartment behind Atrium's synthetic demo scan: the same rooms, doors and windows as
// SyntheticApartment.swift (local frame: x east, z south, y up, floor at 0), but with furniture in
// its real shape, clutter RoomPlan doesn't report, textured materials, mirrors, glossy floors and
// views out of the windows. Rendered to make the phone's photos for the photoreal comparison.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { Reflector } from "three/addons/objects/Reflector.js";

export const H = 2.6;
export const ROOMS = [
  { name: "Living Room", x: [0, 5.0], z: [0, 4.2], paint: "#ece6dc" },
  { name: "Kitchen", x: [5.12, 8.2], z: [0, 4.2], paint: "#eeeae3" },
  { name: "Hallway", x: [3.0, 8.2], z: [4.32, 5.52], paint: "#e9e4da" },
  { name: "Bedroom", x: [0, 2.88], z: [4.32, 8.0], paint: "#cfd8df" },
  { name: "Bathroom", x: [3.0, 5.4], z: [5.64, 8.0], paint: "#f1efea" },
  { name: "Primary Bedroom", x: [5.52, 8.2], z: [5.64, 8.6], paint: "#e6dccd" },
];

// Geometry kinds, for the exported triangles.
export const KIND = { wall: 0, floor: 1, ceiling: 2, furniture: 3, clutter: 4, outside: 5, mirror: 6, trim: 7, glass: 8 };

// ---------- deterministic randomness and canvas textures ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  return c;
}

/** A texture whose UVs are meters, repeating every `meters`. */
function tex(c, meters = 1, metersY = meters) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.repeat.set(1 / meters, 1 / metersY);
  return t;
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, k);
  return `#${c.getHexString()}`;
}

function noiseCanvas(base, amount, seed, size = 256, grain = 1) {
  const r = rng(seed);
  return canvas(size, size, (g, w, h) => {
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y += grain) {
      for (let x = 0; x < w; x += grain) {
        const d = (r() - 0.5) * amount;
        for (let yy = y; yy < Math.min(h, y + grain); yy++) {
          for (let xx = x; xx < Math.min(w, x + grain); xx++) {
            const i = (yy * w + xx) * 4;
            img.data[i] += d;
            img.data[i + 1] += d;
            img.data[i + 2] += d;
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
  });
}

function planks(seed, tones) {
  const r = rng(seed);
  // 2.4 m × 0.96 m of floor: 6 rows of 16 cm planks, staggered.
  return canvas(1024, 410, (g, w, h) => {
    const rows = 6, rowH = h / rows;
    for (let row = 0; row < rows; row++) {
      let x = -r() * 300;
      while (x < w) {
        const len = 260 + r() * 260;
        const tone = tones[Math.floor(r() * tones.length)];
        g.fillStyle = shade(tone, (r() - 0.5) * 0.06);
        g.fillRect(x, row * rowH, len, rowH);
        // Grain.
        for (let k = 0; k < 18; k++) {
          g.strokeStyle = `rgba(60,35,15,${0.05 + r() * 0.08})`;
          g.lineWidth = 0.6 + r() * 1.2;
          const y0 = row * rowH + r() * rowH;
          g.beginPath();
          g.moveTo(x, y0);
          g.bezierCurveTo(x + len * 0.3, y0 + (r() - 0.5) * 8, x + len * 0.7, y0 + (r() - 0.5) * 8, x + len, y0 + (r() - 0.5) * 6);
          g.stroke();
        }
        if (r() < 0.25) {
          g.fillStyle = "rgba(70,40,20,0.25)";
          g.beginPath();
          g.ellipse(x + r() * len, row * rowH + rowH / 2, 6 + r() * 6, 3 + r() * 3, 0, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = "rgba(40,25,10,0.55)";
        g.fillRect(x, row * rowH, 2, rowH);
        x += len;
      }
      g.fillStyle = "rgba(40,25,10,0.45)";
      g.fillRect(0, row * rowH, w, 1.5);
    }
  });
}

function tiles(base, grout, n, seed, vary = 0.04, marble = false) {
  const r = rng(seed);
  return canvas(512, 512, (g, w, h) => {
    const s = w / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        g.fillStyle = shade(base, (r() - 0.5) * vary);
        g.fillRect(i * s, j * s, s, s);
        if (marble) {
          for (let k = 0; k < 5; k++) {
            g.strokeStyle = `rgba(120,120,125,${0.08 + r() * 0.15})`;
            g.lineWidth = 0.5 + r() * 1.5;
            g.beginPath();
            const x0 = i * s + r() * s, y0 = j * s + r() * s;
            g.moveTo(x0, y0);
            g.quadraticCurveTo(x0 + (r() - 0.5) * s, y0 + (r() - 0.5) * s, x0 + (r() - 0.5) * s * 1.5, y0 + (r() - 0.5) * s * 1.5);
            g.stroke();
          }
        }
      }
    }
    g.strokeStyle = grout;
    g.lineWidth = Math.max(2, s * 0.04);
    for (let k = 0; k <= n; k++) {
      g.beginPath();
      g.moveTo(k * s, 0);
      g.lineTo(k * s, h);
      g.moveTo(0, k * s);
      g.lineTo(w, k * s);
      g.stroke();
    }
  });
}

function rugCanvas(seed) {
  const r = rng(seed);
  return canvas(1024, 683, (g, w, h) => {
    g.fillStyle = "#b8463a";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#e9dcc4";
    g.fillRect(28, 28, w - 56, h - 56);
    g.fillStyle = "#1f3a5a";
    g.fillRect(52, 52, w - 104, h - 104);
    // Diamond lattice.
    const cols = 9, rows = 6;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const cx = 52 + ((i + 0.5) * (w - 104)) / cols, cy = 52 + ((j + 0.5) * (h - 104)) / rows;
        const rx = (w - 104) / cols / 2.2, ry = (h - 104) / rows / 2.2;
        g.fillStyle = (i + j) % 2 ? "#d9a441" : "#e9dcc4";
        g.beginPath();
        g.moveTo(cx, cy - ry);
        g.lineTo(cx + rx, cy);
        g.lineTo(cx, cy + ry);
        g.lineTo(cx - rx, cy);
        g.closePath();
        g.fill();
        g.fillStyle = "#b8463a";
        g.beginPath();
        g.arc(cx, cy, Math.min(rx, ry) * 0.3, 0, Math.PI * 2);
        g.fill();
      }
    }
    // Wool texture.
    const img = g.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const d = (r() - 0.5) * 22;
      img.data[i] += d;
      img.data[i + 1] += d;
      img.data[i + 2] += d;
    }
    g.putImageData(img, 0, 0);
  });
}

function painting(seed, palette, w = 600, h = 400) {
  const r = rng(seed);
  return canvas(w, h, (g) => {
    g.fillStyle = palette[0];
    g.fillRect(0, 0, w, h);
    for (let k = 0; k < 14; k++) {
      g.fillStyle = palette[1 + Math.floor(r() * (palette.length - 1))];
      g.globalAlpha = 0.55 + r() * 0.45;
      if (r() < 0.5) {
        g.beginPath();
        g.arc(r() * w, r() * h, 20 + r() * h * 0.35, 0, Math.PI * 2);
        g.fill();
      } else {
        g.save();
        g.translate(r() * w, r() * h);
        g.rotate((r() - 0.5) * 1.2);
        g.fillRect(-r() * 120, -r() * 60, 40 + r() * 200, 20 + r() * 120);
        g.restore();
      }
    }
    g.globalAlpha = 1;
    g.strokeStyle = "rgba(20,20,20,0.7)";
    g.lineWidth = 3;
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.moveTo(r() * w, r() * h);
      g.bezierCurveTo(r() * w, r() * h, r() * w, r() * h, r() * w, r() * h);
      g.stroke();
    }
  });
}

function outside(seed, kind) {
  const r = rng(seed);
  return canvas(1024, 512, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h * 0.7);
    sky.addColorStop(0, "#6f9fd8");
    sky.addColorStop(1, "#cfe2f3");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    for (let k = 0; k < 9; k++) {
      g.fillStyle = `rgba(255,255,255,${0.35 + r() * 0.4})`;
      const cx = r() * w, cy = r() * h * 0.35;
      for (let p = 0; p < 6; p++) {
        g.beginPath();
        g.ellipse(cx + (r() - 0.5) * 90, cy + (r() - 0.5) * 18, 30 + r() * 40, 12 + r() * 12, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (kind === "city") {
      for (let k = 0; k < 16; k++) {
        const bw = 50 + r() * 90, bh = 120 + r() * 260, x = r() * w;
        g.fillStyle = shade("#8e8b86", (r() - 0.5) * 0.25);
        g.fillRect(x, h - bh, bw, bh);
        g.fillStyle = "rgba(40,60,80,0.55)";
        for (let wy = h - bh + 12; wy < h - 20; wy += 22) {
          for (let wx = x + 8; wx < x + bw - 12; wx += 18) g.fillRect(wx, wy, 9, 12);
        }
      }
    }
    // Trees.
    for (let k = 0; k < (kind === "park" ? 26 : 10); k++) {
      const x = r() * w, base = h - (kind === "park" ? r() * 60 : 0), size = 50 + r() * 90;
      g.fillStyle = "#4a3624";
      g.fillRect(x - 5, base - size * 0.9, 10, size * 0.9);
      for (let p = 0; p < 7; p++) {
        g.fillStyle = shade("#3f6b35", (r() - 0.5) * 0.18);
        g.beginPath();
        g.arc(x + (r() - 0.5) * size * 0.8, base - size * (0.9 + r() * 0.7), size * (0.25 + r() * 0.2), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = kind === "park" ? "#6d8f4e" : "#7d7a74";
    g.fillRect(0, h - 18, w, 18);
  });
}

function screenCanvas() {
  return canvas(512, 288, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#f2b36b");
    sky.addColorStop(0.55, "#e46f4f");
    sky.addColorStop(1, "#3b2a4a");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff3c4";
    g.beginPath();
    g.arc(w * 0.62, h * 0.52, 34, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#2a1f35";
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, h * 0.65);
    g.lineTo(w * 0.2, h * 0.45);
    g.lineTo(w * 0.38, h * 0.62);
    g.lineTo(w * 0.55, h * 0.4);
    g.lineTo(w * 0.8, h * 0.66);
    g.lineTo(w, h * 0.5);
    g.lineTo(w, h);
    g.fill();
  });
}

function booksCanvas(seed) {
  const r = rng(seed);
  return canvas(256, 64, (g, w, h) => {
    let x = 0;
    while (x < w) {
      const bw = 6 + r() * 14;
      g.fillStyle = ["#7b2d26", "#1f4e79", "#d9b44a", "#2f5d3a", "#e8e2d5", "#3b3b3b", "#a0522d"][Math.floor(r() * 7)];
      g.fillRect(x, h * (0.08 + r() * 0.15), bw - 1, h);
      x += bw;
    }
  });
}

// ---------- materials ----------
function materials() {
  const m = {};
  const std = (o) => new THREE.MeshStandardMaterial(o);
  for (const [i, room] of ROOMS.entries()) {
    m[`paint${i}`] = std({ color: "#ffffff", map: tex(noiseCanvas(room.paint, 7, 11 + i, 256, 2), 1.2), roughness: 0.92, envMapIntensity: 0.4 });
  }
  m.accent = std({ color: "#ffffff", map: tex(noiseCanvas("#a9b79c", 8, 41, 256, 2), 1.2), roughness: 0.92, envMapIntensity: 0.4 });
  m.ceiling = std({ color: "#f6f4ef", roughness: 0.95, envMapIntensity: 0.3 });
  m.trim = std({ color: "#f8f6f1", roughness: 0.45, envMapIntensity: 0.6 });
  m.oak = std({ color: "#ffffff", map: tex(planks(5, ["#b88a5a", "#a87a4c", "#c39566", "#9f7246"]), 2.4, 0.96), roughness: 0.5, envMapIntensity: 0.8 });
  m.oakDark = std({ color: "#ffffff", map: tex(planks(9, ["#7a5534", "#6b4a2d", "#86603c"]), 2.4, 0.96), roughness: 0.55, envMapIntensity: 0.7 });
  m.kitchenFloor = std({ color: "#ffffff", map: tex(tiles("#d9d6cf", "#a9a49a", 4, 21, 0.05, true), 2.4), roughness: 0.12, envMapIntensity: 1.0 });
  m.bathFloor = std({ color: "#ffffff", map: tex(tiles("#4b5057", "#2c2f33", 6, 23, 0.06), 1.2), roughness: 0.3, envMapIntensity: 0.8 });
  m.bathWall = std({ color: "#ffffff", map: tex(tiles("#f2f2ee", "#c9c6bf", 8, 25, 0.03), 0.8), roughness: 0.15, envMapIntensity: 0.9 });
  m.backsplash = std({ color: "#ffffff", map: tex(tiles("#3f6e7a", "#e5e1d8", 10, 27, 0.08), 0.75, 0.3), roughness: 0.15, envMapIntensity: 0.9 });
  m.fabric = std({ color: "#ffffff", map: tex(noiseCanvas("#5d6d7e", 26, 31, 256, 1), 0.25), roughness: 0.95, envMapIntensity: 0.3 });
  m.fabricCushion = std({ color: "#ffffff", map: tex(noiseCanvas("#687a8c", 24, 33, 256, 1), 0.25), roughness: 0.95, envMapIntensity: 0.3 });
  m.pillowA = std({ color: "#ffffff", map: tex(noiseCanvas("#d9a441", 30, 35, 128, 1), 0.2), roughness: 0.9 });
  m.pillowB = std({ color: "#ffffff", map: tex(noiseCanvas("#e9dcc4", 24, 37, 128, 1), 0.2), roughness: 0.9 });
  m.leather = std({ color: "#ffffff", map: tex(noiseCanvas("#8a4b2a", 16, 39, 256, 1), 0.3), roughness: 0.42, envMapIntensity: 0.9 });
  m.walnut = std({ color: "#ffffff", map: tex(planks(13, ["#5b3a22", "#6a4428", "#553520"]), 1.2, 0.48), roughness: 0.4, envMapIntensity: 0.8 });
  m.lacquer = std({ color: "#f3f1ec", roughness: 0.28, envMapIntensity: 0.9 });
  m.navyLacquer = std({ color: "#25344a", roughness: 0.3, envMapIntensity: 0.9 });
  m.stone = std({ color: "#ffffff", map: tex(noiseCanvas("#d8d4cc", 40, 43, 256, 1), 0.4), roughness: 0.22, envMapIntensity: 1.0 });
  m.steel = std({ color: "#cfd1d4", metalness: 0.9, roughness: 0.28, envMapIntensity: 1.2 });
  m.black = std({ color: "#111214", roughness: 0.35, envMapIntensity: 0.8 });
  m.screen = new THREE.MeshBasicMaterial({ map: (() => { const t = new THREE.CanvasTexture(screenCanvas()); t.colorSpace = THREE.SRGBColorSpace; return t; })() });
  m.ceramic = std({ color: "#f7f7f5", roughness: 0.1, envMapIntensity: 1.1 });
  m.chrome = std({ color: "#e8e8e8", metalness: 1, roughness: 0.08, envMapIntensity: 1.3 });
  m.leaf = std({ color: "#ffffff", map: tex(noiseCanvas("#3f6b35", 40, 45, 128, 2), 0.15), roughness: 0.7 });
  m.leafLight = std({ color: "#ffffff", map: tex(noiseCanvas("#5b8a3e", 40, 47, 128, 2), 0.15), roughness: 0.7 });
  m.terracotta = std({ color: "#b5643c", roughness: 0.85 });
  m.shade = std({ color: "#f3e7cf", emissive: "#ffd9a0", emissiveIntensity: 0.6, roughness: 0.9, side: THREE.DoubleSide });
  m.brass = std({ color: "#c9a54e", metalness: 0.85, roughness: 0.3, envMapIntensity: 1.1 });
  m.rug = std({ color: "#ffffff", map: (() => { const t = new THREE.CanvasTexture(rugCanvas(51)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; })(), roughness: 1, envMapIntensity: 0.2 });
  m.duvet = std({ color: "#ffffff", map: tex(noiseCanvas("#efeae0", 14, 53, 256, 1), 0.3), roughness: 0.95, envMapIntensity: 0.3 });
  m.duvetBlue = std({ color: "#ffffff", map: tex(noiseCanvas("#8fa3b8", 20, 55, 256, 1), 0.3), roughness: 0.95, envMapIntensity: 0.3 });
  m.throw = std({ color: "#ffffff", map: tex(tiles("#c46a4b", "#e8d7c3", 6, 57, 0.08), 0.6), roughness: 0.95 });
  m.door = std({ color: "#f4f2ed", roughness: 0.4, envMapIntensity: 0.7 });
  m.frontDoor = std({ color: "#2f4a3c", roughness: 0.35, envMapIntensity: 0.8 });
  m.glass = new THREE.MeshStandardMaterial({ color: "#d8e6ee", roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.18, envMapIntensity: 1.2 });
  m.books = std({ color: "#ffffff", map: tex(booksCanvas(59), 0.3, 0.075), roughness: 0.8 });
  m.fruit = std({ color: "#e0782a", roughness: 0.5 });
  m.apple = std({ color: "#b22a2a", roughness: 0.35 });
  m.vase = std({ color: "#2d6e7e", roughness: 0.2, envMapIntensity: 1.0 });
  m.coat = std({ color: "#ffffff", map: tex(noiseCanvas("#7a6a55", 30, 61, 128, 1), 0.2), roughness: 0.95 });
  m.coat2 = std({ color: "#ffffff", map: tex(noiseCanvas("#2e3f5c", 30, 63, 128, 1), 0.2), roughness: 0.95 });
  m.towel = std({ color: "#ffffff", map: tex(noiseCanvas("#e8c9a8", 26, 65, 128, 1), 0.15), roughness: 1 });
  m.water = std({ color: "#bcd6de", roughness: 0.05, transparent: true, opacity: 0.6, envMapIntensity: 1.2 });
  const art = (seed, pal) => new THREE.MeshStandardMaterial({ map: (() => { const t = new THREE.CanvasTexture(painting(seed, pal)); t.colorSpace = THREE.SRGBColorSpace; return t; })(), roughness: 0.8 });
  m.art1 = art(71, ["#efe6d6", "#c8553d", "#2a4d69", "#f2b134", "#1d1d1d"]);
  m.art2 = art(73, ["#1e2a38", "#e0b04f", "#b0d0c8", "#e87461", "#f4ede1"]);
  m.art3 = art(75, ["#f4f1ea", "#6b8f71", "#3c4a3e", "#d9a066", "#a33f3f"]);
  m.art4 = art(77, ["#2b2d42", "#8d99ae", "#edf2f4", "#ef233c", "#f2c14e"]);
  for (const [name, t] of [["outPark", "park"], ["outCity", "city"], ["outGarden", "garden"]]) {
    const texture = new THREE.CanvasTexture(outside(name.length * 7 + 3, t));
    texture.colorSpace = THREE.SRGBColorSpace;
    m[name] = new THREE.MeshBasicMaterial({ map: texture, color: "#ffffff" });
  }
  return m;
}

// ---------- building ----------
export function buildApartment() {
  const scene = new THREE.Scene();
  const M = materials();
  const meta = []; // per mesh: { mesh, kind, room }
  const mirrors = [];

  function add(geometry, material, kind, room, position, rotationY = 0, parent = scene) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    mesh.castShadow = kind !== KIND.outside && kind !== KIND.glass;
    mesh.receiveShadow = kind !== KIND.outside;
    parent.add(mesh);
    meta.push({ mesh, kind, room });
    return mesh;
  }
  const v = (x, y, z) => new THREE.Vector3(x, y, z);
  /** Axis-aligned box from min/max corners (then turned about Y around its center). */
  function box(x0, y0, z0, x1, y1, z1, mat, kind, room, round = 0, ry = 0) {
    const g = round > 0 ? new RoundedBoxGeometry(x1 - x0, y1 - y0, z1 - z0, 3, Math.min(round, (Math.min(x1 - x0, y1 - y0, z1 - z0) / 2) * 0.95)) : new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    // Box UVs in meters (so textures keep their scale).
    const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
      const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
      if (ny > 0.5) uv.setXY(i, px, pz);
      else if (nx > 0.5) uv.setXY(i, pz, py);
      else uv.setXY(i, px, py);
    }
    return add(g, mat, kind, room, v((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), ry);
  }
  function cyl(x, y0, z, r0, r1, h, mat, kind, room, seg = 24) {
    return add(new THREE.CylinderGeometry(r1, r0, h, seg), mat, kind, room, v(x, y0 + h / 2, z));
  }
  function sphere(x, y, z, r, mat, kind, room, sx = 1, sy = 1, sz = 1) {
    const m = add(new THREE.SphereGeometry(r, 20, 14), mat, kind, room, v(x, y, z));
    m.scale.set(sx, sy, sz);
    return m;
  }

  /** A framed picture on a wall: its center, the wall's inward normal (axis-aligned), size. */
  function picture(cx, cy, cz, normal, w, h, mat, room) {
    const ry = normal === "+z" ? 0 : normal === "-z" ? Math.PI : normal === "+x" ? Math.PI / 2 : -Math.PI / 2;
    const n = { "+z": v(0, 0, 1), "-z": v(0, 0, -1), "+x": v(1, 0, 0), "-x": v(-1, 0, 0) }[normal];
    const p = v(cx, cy, cz).addScaledVector(n, 0.03);
    add(new THREE.PlaneGeometry(w, h), mat, KIND.clutter, room, p, ry);
    const back = v(cx, cy, cz).addScaledVector(n, 0.014);
    add(new THREE.BoxGeometry(w + 0.04, h + 0.04, 0.028), M.black, KIND.clutter, room, back, ry);
  }

  // ----- openings: the hole each makes in which faces -----
  // side: "n" (z = z0 face), "s" (z = z1), "w" (x = x0), "e" (x = x1). at: along the wall (x for n/s, z for e/w).
  const openings = [
    { kind: "door", faces: [[0, "s"], [2, "n"]], at: 4.0, w: 0.9, y0: 0, y1: 2.05, leaf: { hinge: "-", into: 0 } },
    { kind: "opening", faces: [[0, "e"], [1, "w"]], at: 2.0, w: 1.8, y0: 0, y1: 2.15 },
    { kind: "door", faces: [[2, "w"], [3, "e"]], at: 4.92, w: 0.85, y0: 0, y1: 2.05, leaf: { hinge: "-", into: 3 } },
    { kind: "door", faces: [[2, "s"], [4, "n"]], at: 4.2, w: 0.8, y0: 0, y1: 2.05, leaf: { hinge: "+", into: 4 } },
    { kind: "door", faces: [[2, "s"], [5, "n"]], at: 6.8, w: 0.85, y0: 0, y1: 2.05, leaf: { hinge: "+", into: 5 } },
    { kind: "front", faces: [[2, "e"]], at: 4.92, w: 0.95, y0: 0, y1: 2.1 },
    { kind: "window", faces: [[0, "n"]], at: 1.3, w: 1.5, y0: 0.7, y1: 2.25, view: "outPark" },
    { kind: "window", faces: [[0, "w"]], at: 2.1, w: 1.4, y0: 0.7, y1: 2.25, view: "outCity" },
    { kind: "window", faces: [[1, "n"]], at: 6.6, w: 1.2, y0: 1.05, y1: 2.15, view: "outPark" },
    { kind: "window", faces: [[3, "s"]], at: 0.9, w: 1.0, y0: 0.8, y1: 2.2, view: "outGarden" },
    { kind: "window", faces: [[4, "s"]], at: 4.2, w: 0.6, y0: 1.45, y1: 2.05, view: "outGarden" },
    { kind: "window", faces: [[5, "s"]], at: 6.9, w: 1.6, y0: 0.8, y1: 2.2, view: "outGarden" },
    { kind: "window", faces: [[5, "e"]], at: 7.2, w: 1.2, y0: 0.8, y1: 2.2, view: "outCity" },
  ];

  /** A face of a room: origin, along-wall direction, inward normal, length. */
  function face(ri, side) {
    const r = ROOMS[ri];
    const [x0, x1] = r.x, [z0, z1] = r.z;
    switch (side) {
      case "n": return { o: v(x0, 0, z0), u: v(1, 0, 0), n: v(0, 0, 1), len: x1 - x0, ry: 0, s: (at) => at - x0 };
      case "s": return { o: v(x1, 0, z1), u: v(-1, 0, 0), n: v(0, 0, -1), len: x1 - x0, ry: Math.PI, s: (at) => x1 - at };
      case "w": return { o: v(x0, 0, z1), u: v(0, 0, -1), n: v(1, 0, 0), len: z1 - z0, ry: Math.PI / 2, s: (at) => z1 - at };
      default: return { o: v(x1, 0, z0), u: v(0, 0, 1), n: v(-1, 0, 0), len: z1 - z0, ry: -Math.PI / 2, s: (at) => at - z0 };
    }
  }

  // ----- rooms: walls with holes, floors, ceilings, baseboards -----
  const floorMats = [M.oak, M.kitchenFloor, M.oakDark, M.oak, M.bathFloor, M.oakDark];
  for (const [ri, r] of ROOMS.entries()) {
    const [x0, x1] = r.x, [z0, z1] = r.z;
    // Floor and ceiling (UVs in meters).
    const fg = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    fg.rotateX(-Math.PI / 2);
    const fuv = fg.attributes.uv, fpos = fg.attributes.position;
    for (let i = 0; i < fpos.count; i++) fuv.setXY(i, fpos.getX(i) + (x0 + x1) / 2, -(fpos.getZ(i) + (z0 + z1) / 2));
    add(fg, floorMats[ri], KIND.floor, ri, v((x0 + x1) / 2, 0, (z0 + z1) / 2));
    const cg = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    cg.rotateX(Math.PI / 2);
    add(cg, M.ceiling, KIND.ceiling, ri, v((x0 + x1) / 2, H, (z0 + z1) / 2));

    for (const side of ["n", "e", "s", "w"]) {
      const f = face(ri, side);
      const holes = openings.filter((o) => o.faces.some(([fr, fs]) => fr === ri && fs === side));
      // Doors reaching the floor are notches in the outline; windows are holes.
      const notches = holes.filter((o) => o.y0 <= 0.001).map((o) => [f.s(o.at) - o.w / 2, f.s(o.at) + o.w / 2, o.y1]).sort((a, b) => a[0] - b[0]);
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      for (const [a, b, top] of notches) {
        shape.lineTo(a, 0);
        shape.lineTo(a, top);
        shape.lineTo(b, top);
        shape.lineTo(b, 0);
      }
      shape.lineTo(f.len, 0);
      shape.lineTo(f.len, H);
      shape.lineTo(0, H);
      shape.closePath();
      for (const o of holes.filter((o) => o.y0 > 0.001)) {
        const a = f.s(o.at) - o.w / 2, b = f.s(o.at) + o.w / 2;
        const hole = new THREE.Path();
        hole.moveTo(a, o.y0);
        hole.lineTo(a, o.y1);
        hole.lineTo(b, o.y1);
        hole.lineTo(b, o.y0);
        hole.closePath();
        shape.holes.push(hole);
      }
      const wg = new THREE.ShapeGeometry(shape);
      const accent = ri === 0 && side === "s";
      const mat = ri === 4 ? M[`paint${ri}`] : accent ? M.accent : M[`paint${ri}`];
      add(wg, mat, KIND.wall, ri, f.o, f.ry);
      // Bathroom: tiles on the lower 1.2 m (a thin layer in front of the paint).
      if (ri === 4) {
        const tshape = new THREE.Shape();
        tshape.moveTo(0, 0);
        const tn = notches.length ? notches : [];
        for (const [a, b] of tn) {
          tshape.lineTo(a, 0);
          tshape.lineTo(a, 1.2);
          tshape.lineTo(b, 1.2);
          tshape.lineTo(b, 0);
        }
        tshape.lineTo(f.len, 0);
        tshape.lineTo(f.len, 1.2);
        tshape.lineTo(0, 1.2);
        tshape.closePath();
        const tg = new THREE.ShapeGeometry(tshape);
        const m = add(tg, M.bathWall, KIND.wall, ri, f.o.clone().addScaledVector(f.n, 0.006), f.ry);
        m.castShadow = false;
      }
      // Baseboard: 9 cm tall, 1.5 cm proud, broken at doors.
      if (ri !== 4) {
        let s0 = 0;
        const cuts = [...notches.map(([a, b]) => [a, b]), [f.len, f.len]];
        for (const [a, b] of cuts) {
          if (a - s0 > 0.05) {
            const p0 = f.o.clone().addScaledVector(f.u, s0), p1 = f.o.clone().addScaledVector(f.u, a);
            const mid = p0.clone().add(p1).multiplyScalar(0.5).addScaledVector(f.n, 0.0075);
            const g = new THREE.BoxGeometry(a - s0, 0.09, 0.015);
            add(g, M.trim, KIND.trim, ri, v(mid.x, 0.045, mid.z), f.ry);
          }
          s0 = b;
        }
      }
    }
  }

  // ----- openings: jambs, casings, doors, windows -----
  for (const o of openings) {
    const [ri, side] = o.faces[0];
    const f = face(ri, side);
    const s = f.s(o.at);
    const center = f.o.clone().addScaledVector(f.u, s);
    // Depth through the wall: to the other room's face, or 0.2 m to the outside.
    let depth = 0.2;
    if (o.faces.length > 1) {
      const g = face(o.faces[1][0], o.faces[1][1]);
      depth = Math.abs(center.clone().sub(g.o).dot(f.n));
    }
    const back = center.clone().addScaledVector(f.n, -depth / 2); // middle of the wall
    const along = f.u, inward = f.n;
    // Jambs and head (and a sill for windows).
    const jamb = (offset, w, y0, y1) => {
      const p = back.clone().addScaledVector(along, offset);
      add(new THREE.BoxGeometry(w, y1 - y0, depth), M.trim, KIND.trim, ri, v(p.x, (y0 + y1) / 2, p.z), f.ry);
    };
    jamb(-o.w / 2 - 0.01, 0.02, o.y0, o.y1);
    jamb(o.w / 2 + 0.01, 0.02, o.y0, o.y1);
    const head = back.clone();
    add(new THREE.BoxGeometry(o.w + 0.04, 0.02, depth), M.trim, KIND.trim, ri, v(head.x, o.y1 + 0.01, head.z), f.ry);
    if (o.kind === "window") {
      const sill = back.clone().addScaledVector(inward, 0.03);
      add(new THREE.BoxGeometry(o.w + 0.1, 0.03, depth + 0.06), M.trim, KIND.trim, ri, v(sill.x, o.y0 - 0.015, sill.z), f.ry);
    }
    // Casings on the room sides.
    for (const [fr, fs] of o.faces) {
      if (o.kind === "window" && fr !== ri) continue;
      const g = face(fr, fs);
      const c = g.o.clone().addScaledVector(g.u, g.s(o.at)).addScaledVector(g.n, 0.008);
      const cw = 0.07;
      for (const k of [-1, 1]) {
        const p = c.clone().addScaledVector(g.u, k * (o.w / 2 + cw / 2));
        add(new THREE.BoxGeometry(cw, o.y1 - o.y0 + cw, 0.016), M.trim, KIND.trim, fr, v(p.x, (o.y0 + o.y1 + cw) / 2, p.z), g.ry);
      }
      add(new THREE.BoxGeometry(o.w + 2 * cw, cw, 0.016), M.trim, KIND.trim, fr, v(c.x, o.y1 + cw / 2, c.z), g.ry);
      if (o.kind === "window") add(new THREE.BoxGeometry(o.w + 2 * cw, cw, 0.016), M.trim, KIND.trim, fr, v(c.x, o.y0 - cw / 2, c.z), g.ry);
    }
    // Floor threshold through the doorway.
    if (o.y0 <= 0.001 && o.faces.length > 1) {
      const t = back.clone();
      add(new THREE.BoxGeometry(o.w, 0.008, depth + 0.02), M.oak, KIND.floor, ri, v(t.x, 0.004, t.z), f.ry);
    }
    if (o.kind === "window") {
      // Frame, mullion, glass, and the view outside.
      const frameAt = back.clone();
      const fw = 0.05;
      for (const k of [-1, 1]) {
        const p = frameAt.clone().addScaledVector(along, k * (o.w / 2 - fw / 2));
        add(new THREE.BoxGeometry(fw, o.y1 - o.y0, 0.06), M.trim, KIND.trim, ri, v(p.x, (o.y0 + o.y1) / 2, p.z), f.ry);
      }
      add(new THREE.BoxGeometry(o.w, fw, 0.06), M.trim, KIND.trim, ri, v(frameAt.x, o.y1 - fw / 2, frameAt.z), f.ry);
      add(new THREE.BoxGeometry(o.w, fw, 0.06), M.trim, KIND.trim, ri, v(frameAt.x, o.y0 + fw / 2, frameAt.z), f.ry);
      if (o.w > 1.1) add(new THREE.BoxGeometry(0.04, o.y1 - o.y0, 0.05), M.trim, KIND.trim, ri, v(frameAt.x, (o.y0 + o.y1) / 2, frameAt.z), f.ry);
      const glass = new THREE.PlaneGeometry(o.w - 2 * fw, o.y1 - o.y0 - 2 * fw);
      const gm = add(glass, M.glass, KIND.glass, ri, v(frameAt.x, (o.y0 + o.y1) / 2, frameAt.z), f.ry);
      gm.castShadow = false;
      const outC = center.clone().addScaledVector(inward, -4.5);
      const out = new THREE.PlaneGeometry(9, 5);
      add(out, M[o.view], KIND.outside, ri, v(outC.x, 1.6, outC.z), f.ry);
    }
    if (o.kind === "front") {
      const p = back.clone().addScaledVector(inward, depth / 2 - 0.03);
      add(new THREE.BoxGeometry(o.w - 0.01, o.y1 - 0.01, 0.04), M.frontDoor, KIND.trim, ri, v(p.x, (o.y1 - 0.01) / 2, p.z), f.ry);
      const knob = p.clone().addScaledVector(along, -o.w / 2 + 0.1).addScaledVector(inward, 0.04);
      sphere(knob.x, 1.0, knob.z, 0.03, M.brass, KIND.trim, ri);
    }
    if (o.leaf) {
      // Open 90° into room `into`, hinged on the + or − jamb.
      const into = o.leaf.into;
      const g = face(into, o.faces.find(([fr]) => fr === into)[1]);
      const hingeS = g.s(o.at) + (o.leaf.hinge === "+" ? o.w / 2 : -o.w / 2);
      const hinge = g.o.clone().addScaledVector(g.u, hingeS);
      const towardDoor = o.leaf.hinge === "+" ? -1 : 1;
      const p = hinge.clone().addScaledVector(g.n, o.w / 2 + 0.01).addScaledVector(g.u, towardDoor * 0.025);
      add(new THREE.BoxGeometry(0.04, o.y1 - 0.02, o.w - 0.02), M.door, KIND.clutter, into, v(p.x, (o.y1 - 0.02) / 2, p.z), g.ry);
      const k = p.clone().addScaledVector(g.n, o.w / 2 - 0.1);
      for (const sgn of [-1, 1]) {
        const kp = k.clone().addScaledVector(g.u, sgn * 0.04);
        sphere(kp.x, 1.0, kp.z, 0.025, M.brass, KIND.clutter, into);
      }
    }
  }

  // ----- furniture (the scan's objects, in their real shape) -----
  const F = KIND.furniture, C = KIND.clutter;
  // Living room.
  // Sofa: 2.2 × 0.85 × 0.9 centered (3.0, 3.72), back to the south wall.
  {
    const x0 = 1.9, x1 = 4.1, z0 = 3.27, z1 = 4.17;
    box(x0 + 0.02, 0.06, z0 + 0.05, x1 - 0.02, 0.24, z1 - 0.02, M.fabric, F, 0, 0.03);
    for (const [a, b] of [[x0, x0 + 0.2], [x1 - 0.2, x1]]) box(a, 0.06, z0, b, 0.62, z1, M.fabric, F, 0, 0.06);
    box(x0 + 0.2, 0.24, z1 - 0.22, x1 - 0.2, 0.85, z1, M.fabric, F, 0, 0.06);
    const seatW = (x1 - x0 - 0.4) / 3;
    for (let k = 0; k < 3; k++) {
      const a = x0 + 0.2 + k * seatW;
      box(a + 0.005, 0.24, z0 + 0.03, a + seatW - 0.005, 0.44, z1 - 0.2, M.fabricCushion, F, 0, 0.05);
      box(a + 0.01, 0.44, z1 - 0.38, a + seatW - 0.01, 0.8, z1 - 0.2, M.fabricCushion, F, 0, 0.07);
    }
    for (const x of [x0 + 0.06, x1 - 0.06]) for (const z of [z0 + 0.06, z1 - 0.06]) cyl(x, 0, z, 0.025, 0.02, 0.06, M.walnut, F, 0, 10);
    const p1 = box(2.25, 0.44, 3.72, 2.7, 0.82, 3.86, M.pillowA, C, 0, 0.07, 0.25);
    const p2 = box(3.35, 0.44, 3.72, 3.8, 0.8, 3.86, M.pillowB, C, 0, 0.07, -0.2);
    void p1, p2;
    box(3.2, 0.44, 3.36, 3.75, 0.5, 3.75, M.throw, C, 0, 0.02, 0.1);
  }
  // Armchair: 0.8 cube at (1.0, 2.7), facing the coffee table (east).
  {
    const g = new THREE.Group();
    g.position.set(1.0, 0, 2.7);
    g.rotation.y = -Math.PI / 2 + 0.35;
    scene.add(g);
    const part = (w, h, d, x, y, z, mat, round) => {
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, round), mat);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      meta.push({ mesh: m, kind: F, room: 0 });
    };
    part(0.66, 0.2, 0.66, 0, 0.32, 0.02, M.leather, 0.06);
    part(0.66, 0.5, 0.14, 0, 0.62, 0.33, M.leather, 0.06);
    part(0.12, 0.3, 0.7, -0.34, 0.5, 0.02, M.leather, 0.05);
    part(0.12, 0.3, 0.7, 0.34, 0.5, 0.02, M.leather, 0.05);
    for (const x of [-0.3, 0.3]) for (const z of [-0.3, 0.3]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.015, 0.22, 8), M.walnut);
      leg.position.set(x, 0.11, z);
      leg.castShadow = true;
      g.add(leg);
      meta.push({ mesh: leg, kind: F, room: 0 });
    }
  }
  // Coffee table 1.1 × 0.42 × 0.6 at (3.0, 2.6): walnut top on black legs, books and a vase.
  box(2.45, 0.38, 2.3, 3.55, 0.42, 2.9, M.walnut, F, 0, 0.01);
  box(2.5, 0.1, 2.35, 3.5, 0.12, 2.85, M.walnut, F, 0, 0.005);
  for (const x of [2.5, 3.5]) for (const z of [2.35, 2.85]) box(x - 0.015, 0, z - 0.015, x + 0.015, 0.38, z + 0.015, M.black, F, 0);
  box(2.6, 0.42, 2.45, 2.92, 0.47, 2.68, M.books, C, 0, 0, 0.2);
  box(2.62, 0.47, 2.47, 2.88, 0.5, 2.66, M.art2, C, 0, 0, 0.35);
  cyl(3.25, 0.42, 2.6, 0.06, 0.045, 0.26, M.vase, C, 0);
  // TV console 1.6 × 0.5 × 0.42 at (3.4, 0.22) with drawers, and the TV on it.
  box(2.6, 0.12, 0.01, 4.2, 0.5, 0.43, M.walnut, F, 0, 0.01);
  for (const x of [2.65, 4.15]) for (const z of [0.05, 0.39]) box(x - 0.015, 0, z - 0.015, x + 0.015, 0.12, z + 0.015, M.black, F, 0);
  for (let k = 0; k < 3; k++) {
    const a = 2.64 + k * 0.51;
    box(a, 0.15, 0.43, a + 0.49, 0.47, 0.435, M.walnut, F, 0, 0.003);
    box(a + 0.2, 0.3, 0.435, a + 0.29, 0.315, 0.45, M.brass, F, 0);
  }
  box(2.75, 0.52, 0.05, 4.05, 1.27, 0.11, M.black, F, 0, 0.01);
  add(new THREE.PlaneGeometry(1.26, 0.71), M.screen, F, 0, v(3.4, 0.895, 0.111));
  box(3.25, 0.5, 0.1, 3.55, 0.52, 0.3, M.black, F, 0);
  box(2.68, 0.5, 0.15, 2.88, 0.58, 0.32, M.books, C, 0);
  // Rug under the coffee table, a floor lamp, a plant, art over the sofa.
  {
    const g = new THREE.PlaneGeometry(2.6, 1.73);
    g.rotateX(-Math.PI / 2);
    add(g, M.rug, C, 0, v(2.95, 0.006, 2.55));
  }
  cyl(0.45, 0, 3.85, 0.16, 0.16, 0.025, M.black, C, 0);
  cyl(0.45, 0.025, 3.85, 0.012, 0.012, 1.45, M.brass, C, 0, 8);
  cyl(0.45, 1.35, 3.85, 0.22, 0.15, 0.3, M.shade, C, 0, 28);
  cyl(4.6, 0, 0.42, 0.14, 0.18, 0.36, M.terracotta, C, 0);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2, rr = 0.12 + (k % 3) * 0.05;
    sphere(4.6 + Math.cos(a) * rr, 0.55 + (k % 4) * 0.13, 0.42 + Math.sin(a) * rr, 0.14, k % 2 ? M.leaf : M.leafLight, C, 0, 1, 1.4, 0.6);
  }
  picture(3.0, 1.7, 4.2, "-z", 1.2, 0.8, M.art1, 0);
  picture(0.0, 1.6, 0.8, "+x", 0.4, 0.6, M.art3, 0);
  // Side table + lamp by the armchair.
  cyl(1.05, 0, 3.55, 0.2, 0.2, 0.55, M.walnut, C, 0, 20);
  cyl(1.05, 0.55, 3.55, 0.06, 0.08, 0.25, M.ceramic, C, 0);
  cyl(1.05, 0.8, 3.55, 0.16, 0.11, 0.2, M.shade, C, 0, 24);

  // Kitchen: base cabinets along the east wall, counter, backsplash, upper cabinets, fridge, table and chairs.
  {
    const xb = 7.6; // cabinet fronts
    box(xb, 0.1, 0.7, 8.2, 0.88, 3.32, M.navyLacquer, F, 1);
    box(xb + 0.05, 0, 0.7, 8.2, 0.1, 3.32, M.black, F, 1);
    for (let k = 0; k < 6; k++) {
      const z = 0.72 + k * 0.433;
      box(xb - 0.005, 0.12, z, xb, 0.86, z + 0.42, M.navyLacquer, F, 1, 0.003);
      box(xb - 0.025, 0.7, z + 0.15, xb - 0.005, 0.72, z + 0.27, M.brass, F, 1);
    }
    box(xb - 0.03, 0.88, 0.68, 8.2, 0.92, 3.34, M.stone, F, 1, 0.005);
    // Sink basin and faucet; stove top with burners.
    box(7.7, 0.9, 2.05, 8.05, 0.921, 2.55, M.steel, F, 1);
    cyl(8.1, 0.92, 2.3, 0.02, 0.02, 0.3, M.chrome, F, 1, 10);
    box(7.95, 1.2, 2.29, 8.11, 1.22, 2.31, M.chrome, F, 1);
    box(7.62, 0.92, 0.72, 8.18, 0.93, 1.38, M.black, F, 1);
    for (const [x, z] of [[7.76, 0.88], [7.76, 1.22], [8.02, 0.88], [8.02, 1.22]]) cyl(x, 0.93, z, 0.08, 0.08, 0.004, M.steel, F, 1, 24);
    // Backsplash and upper cabinets.
    add(new THREE.PlaneGeometry(2.64, 0.6), M.backsplash, KIND.wall, 1, v(8.195, 1.22, 2.01), -Math.PI / 2);
    box(7.85, 1.52, 0.7, 8.2, 2.25, 3.32, M.lacquer, C, 1);
    for (let k = 0; k < 6; k++) {
      const z = 0.72 + k * 0.433;
      box(7.845, 1.54, z, 7.85, 2.23, z + 0.42, M.lacquer, C, 1, 0.003);
      box(7.83, 1.56, z + 0.19, 7.845, 1.72, z + 0.23, M.brass, C, 1);
    }
    // Fridge 0.7 × 1.8 × 0.75 at (7.85, 3.7).
    box(7.5, 0.0, 3.33, 8.2, 1.8, 4.07, M.steel, F, 1, 0.02);
    box(7.48, 1.15, 3.36, 7.5, 1.17, 4.04, M.black, F, 1);
    box(7.46, 0.5, 3.4, 7.48, 1.1, 3.43, M.chrome, F, 1);
    box(7.46, 1.25, 3.4, 7.48, 1.7, 3.43, M.chrome, F, 1);
    // Kettle and fruit bowl.
    cyl(7.85, 0.92, 2.9, 0.09, 0.07, 0.22, M.steel, C, 1);
    cyl(7.82, 0.92, 1.6, 0.13, 0.07, 0.08, M.ceramic, C, 1);
    for (const [dx, dz, m] of [[0, 0, M.fruit], [0.06, 0.04, M.apple], [-0.05, 0.05, M.fruit]]) sphere(7.82 + dx, 1.04, 1.6 + dz, 0.045, m, C, 1);
    // Dining table 0.9 × 0.75 × 1.5 at (6.3, 2.2), four chairs.
    box(5.85, 0.71, 1.45, 6.75, 0.75, 2.95, M.walnut, F, 1, 0.01);
    for (const x of [5.92, 6.68]) for (const z of [1.52, 2.88]) box(x - 0.025, 0, z - 0.025, x + 0.025, 0.71, z + 0.025, M.walnut, F, 1);
    for (const [cx, cz, back] of [[5.75, 1.85, -1], [5.75, 2.55, -1], [6.85, 1.85, 1], [6.85, 2.55, 1]]) {
      box(cx - 0.21, 0.43, cz - 0.21, cx + 0.21, 0.47, cz + 0.21, M.oakDark, F, 1, 0.01);
      for (const dx of [-0.18, 0.18]) for (const dz of [-0.18, 0.18]) box(cx + dx - 0.015, 0, cz + dz - 0.015, cx + dx + 0.015, 0.43, cz + dz + 0.015, M.black, F, 1);
      const bx = cx + back * 0.2;
      box(bx - 0.02, 0.47, cz - 0.21, bx + 0.02, 0.9, cz + 0.21, M.oakDark, F, 1, 0.01);
    }
    // Pendant lamp over the table.
    cyl(6.3, 1.65, 2.2, 0.004, 0.004, 0.95, M.black, C, 1, 6);
    cyl(6.3, 1.45, 2.2, 0.25, 0.06, 0.22, M.brass, C, 1, 28);
    box(6.0, 0.75, 2.05, 6.6, 0.76, 2.35, M.throw, C, 1);
  }

  // Hallway: console with a mirror over it, coats by the front door, a runner rug.
  box(5.4, 0.72, 4.33, 6.4, 0.76, 4.73, M.walnut, F, 2, 0.01);
  for (const x of [5.43, 6.37]) for (const z of [4.36, 4.7]) box(x - 0.015, 0, z - 0.015, x + 0.015, 0.72, z + 0.015, M.black, F, 2);
  cyl(5.6, 0.76, 4.5, 0.07, 0.05, 0.18, M.vase, C, 2);
  box(6.0, 0.76, 4.42, 6.3, 0.8, 4.6, M.books, C, 2);
  {
    const mirror = new Reflector(new THREE.PlaneGeometry(0.9, 0.8), { textureWidth: 512, textureHeight: 512, color: 0xb8bcc0 });
    mirror.position.set(5.9, 1.45, 4.326);
    scene.add(mirror);
    mirrors.push(mirror);
    meta.push({ mesh: mirror, kind: KIND.mirror, room: 2 });
    box(5.42, 1.03, 4.32, 6.38, 1.07, 4.335, M.brass, C, 2);
    box(5.42, 1.83, 4.32, 6.38, 1.87, 4.335, M.brass, C, 2);
    box(5.42, 1.03, 4.32, 5.46, 1.87, 4.335, M.brass, C, 2);
    box(6.34, 1.03, 4.32, 6.38, 1.87, 4.335, M.brass, C, 2);
  }
  box(7.55, 1.62, 5.505, 8.05, 1.66, 5.52, M.walnut, C, 2);
  for (const [x, m] of [[7.65, M.coat], [7.9, M.coat2]]) {
    box(x - 0.17, 0.75, 5.36, x + 0.17, 1.6, 5.5, m, C, 2, 0.06);
  }
  {
    const g = new THREE.PlaneGeometry(3.2, 0.7);
    g.rotateX(-Math.PI / 2);
    add(g, M.rug, C, 2, v(5.6, 0.006, 4.92));
  }

  // Bedroom: bed with headboard on the west wall, nightstands with lamps, wardrobe, art, rug.
  {
    const bx0 = 0.075, bx1 = 2.125, bz0 = 5.6, bz1 = 7.2;
    box(bx0 + 0.06, 0.06, bz0, bx1, 0.3, bz1, M.oakDark, F, 3, 0.02);
    box(bx0, 0.0, bz0 - 0.02, bx0 + 0.07, 1.05, bz1 + 0.02, M.fabricCushion, F, 3, 0.03);
    box(bx0 + 0.08, 0.3, bz0 + 0.02, bx1 - 0.02, 0.52, bz1 - 0.02, M.duvet, F, 3, 0.06);
    box(bx0 + 0.6, 0.5, bz0 - 0.005, bx1, 0.56, bz1 + 0.005, M.duvetBlue, F, 3, 0.03);
    box(bx0 + 0.12, 0.52, bz0 + 0.1, bx0 + 0.5, 0.66, bz0 + 0.74, M.pillowB, C, 3, 0.06);
    box(bx0 + 0.12, 0.52, bz1 - 0.74, bx0 + 0.5, 0.66, bz1 - 0.1, M.pillowB, C, 3, 0.06);
    box(bx0 + 0.45, 0.56, bz0 + 0.5, bx0 + 0.6, 0.72, bz1 - 0.5, M.pillowA, C, 3, 0.05);
    for (const z of [5.3, 7.5]) {
      box(0.03, 0.0, z - 0.22, 0.47, 0.55, z + 0.22, M.walnut, F, 3, 0.01);
      box(0.47, 0.32, z - 0.05, 0.48, 0.34, z + 0.05, M.brass, F, 3);
      cyl(0.25, 0.55, z, 0.05, 0.07, 0.2, M.ceramic, C, 3);
      cyl(0.25, 0.75, z, 0.13, 0.09, 0.17, M.shade, C, 3, 24);
    }
    // Wardrobe 1.2 × 2.0 × 0.6 at (2.2, 7.65).
    box(1.6, 0.0, 7.35, 2.8, 2.0, 7.95, M.lacquer, F, 3, 0.01);
    box(2.195, 0.05, 7.34, 2.205, 1.95, 7.35, M.black, F, 3);
    for (const x of [2.15, 2.25]) box(x - 0.01, 0.9, 7.32, x + 0.01, 1.2, 7.34, M.brass, F, 3);
    picture(0.0, 1.5, 6.4, "+x", 0.8, 0.55, M.art4, 3);
    const g = new THREE.PlaneGeometry(1.4, 2.0);
    g.rotateX(-Math.PI / 2);
    add(g, M.rug, C, 3, v(1.3, 0.006, 6.4));
  }

  // Bathroom: toilet, bathtub on the east wall, vanity with a mirror on the west wall, towels.
  {
    // Toilet 0.4 × 0.75 × 0.65 at (3.35, 7.6), tank against the south wall.
    box(3.17, 0.0, 7.4, 3.53, 0.4, 7.82, M.ceramic, F, 4, 0.08);
    box(3.15, 0.4, 7.36, 3.55, 0.44, 7.83, M.ceramic, F, 4, 0.02);
    box(3.15, 0.44, 7.8, 3.55, 0.75, 7.98, M.ceramic, F, 4, 0.03);
    // Bathtub 0.75 × 0.55 × 1.7 at (5.0, 6.9).
    const t0 = 4.625, t1 = 5.375, z0 = 6.05, z1 = 7.75;
    box(t0, 0, z0, t1, 0.55, z0 + 0.07, M.ceramic, F, 4, 0.02);
    box(t0, 0, z1 - 0.07, t1, 0.55, z1, M.ceramic, F, 4, 0.02);
    box(t0, 0, z0, t0 + 0.07, 0.55, z1, M.ceramic, F, 4, 0.02);
    box(t1 - 0.07, 0, z0, t1, 0.55, z1, M.ceramic, F, 4, 0.02);
    box(t0 + 0.07, 0, z0 + 0.07, t1 - 0.07, 0.1, z1 - 0.07, M.ceramic, F, 4);
    box(t0 + 0.07, 0.1, z0 + 0.07, t1 - 0.07, 0.36, z1 - 0.07, M.water, F, 4);
    cyl(5.3, 0.55, 7.62, 0.015, 0.015, 0.25, M.chrome, C, 4, 10);
    // Vanity 0.5 × 0.85 × 0.8 at (3.27, 6.3) on the west wall; mirror above.
    box(3.0, 0.1, 5.9, 3.52, 0.82, 6.7, M.walnut, F, 4, 0.01);
    box(3.0, 0.82, 5.88, 3.54, 0.86, 6.72, M.stone, F, 4, 0.005);
    cyl(3.27, 0.86, 6.3, 0.18, 0.14, 0.12, M.ceramic, F, 4, 28);
    cyl(3.08, 0.86, 6.3, 0.015, 0.015, 0.22, M.chrome, F, 4, 10);
    const mirror = new Reflector(new THREE.PlaneGeometry(0.7, 0.8), { textureWidth: 512, textureHeight: 512, color: 0xb8bcc0 });
    mirror.position.set(3.008, 1.5, 6.3);
    mirror.rotation.y = Math.PI / 2;
    scene.add(mirror);
    mirrors.push(mirror);
    meta.push({ mesh: mirror, kind: KIND.mirror, room: 4 });
    box(3.38, 0.9, 7.98, 3.6, 1.4, 8.0, M.towel, C, 4);
    box(4.45, 0.95, 5.645, 4.85, 1.45, 5.7, M.towel, C, 4);
  }

  // Primary bedroom: bed with headboard on the south wall, dresser, plant, art, rug.
  {
    const bx0 = 5.96, bx1 = 7.76, bz0 = 6.45, bz1 = 8.55;
    box(bx0, 0.06, bz0, bx1, 0.3, bz1 - 0.06, M.walnut, F, 5, 0.02);
    box(bx0 - 0.05, 0.0, bz1 - 0.07, bx1 + 0.05, 1.1, bz1, M.leather, F, 5, 0.03);
    box(bx0 + 0.02, 0.3, bz0 + 0.02, bx1 - 0.02, 0.52, bz1 - 0.08, M.duvet, F, 5, 0.06);
    box(bx0 - 0.005, 0.5, bz0 - 0.005, bx1 + 0.005, 0.56, bz0 + 0.9, M.throw, F, 5, 0.03);
    for (const x of [bx0 + 0.45, bx1 - 0.45]) box(x - 0.36, 0.52, bz1 - 0.5, x + 0.36, 0.67, bz1 - 0.12, M.pillowB, C, 5, 0.06);
    // Dresser 0.5 × 0.8 × 1.2 at (7.95, 6.4) on the east wall.
    box(7.7, 0.0, 5.8, 8.2, 0.8, 7.0, M.oakDark, F, 5, 0.01);
    for (let k = 0; k < 3; k++) {
      const y = 0.08 + k * 0.24;
      box(7.695, y, 5.84, 7.7, y + 0.2, 6.96, M.oakDark, F, 5);
      box(7.68, y + 0.09, 6.3, 7.695, y + 0.11, 6.5, M.brass, F, 5);
    }
    cyl(7.95, 0.8, 6.0, 0.1, 0.07, 0.3, M.vase, C, 5);
    cyl(5.8, 0, 8.3, 0.17, 0.2, 0.42, M.terracotta, C, 5);
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2, rr = 0.1 + (k % 3) * 0.06;
      sphere(5.8 + Math.cos(a) * rr, 0.65 + (k % 5) * 0.16, 8.3 + Math.sin(a) * rr, 0.16, k % 2 ? M.leafLight : M.leaf, C, 5, 0.7, 1.5, 0.7);
    }
    picture(6.86, 1.62, 8.6, "-z", 1.0, 0.65, M.art2, 5);
    const g = new THREE.PlaneGeometry(2.4, 1.6);
    g.rotateX(-Math.PI / 2);
    add(g, M.rug, C, 5, v(6.86, 0.006, 6.9));
  }

  return { scene, meta, mirrors, materials: M };
}

/** Lights: a warm ceiling light per room (with shadows), soft sky light, low sun through the west and south windows. */
export function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xfff6ec, 0x8a7560, 0.55));
  const ceilings = [[2.5, 2.1, 9], [6.6, 2.1, 7], [5.6, 4.92, 3.5], [1.44, 6.16, 6], [4.2, 6.82, 4], [6.86, 7.12, 6]];
  for (const [x, z, power] of ceilings) {
    const light = new THREE.PointLight(0xffe3c4, power, 0, 2);
    light.position.set(x, H - 0.25, z);
    light.castShadow = true;
    light.shadow.mapSize.set(512, 512);
    light.shadow.bias = -0.002;
    light.shadow.radius = 4;
    scene.add(light);
  }
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(-6, 5.5, 9);
  sun.target.position.set(3.5, 0, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 30 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);
}
