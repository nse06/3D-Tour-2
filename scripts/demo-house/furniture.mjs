// Parametric furniture built from primitives. Every piece is authored in a
// local frame where y=0 is the floor and the piece "faces" +z; callers place
// it with b.group(position, rotY, ...).

import { rng } from "./textures.mjs";

export function shadow(b, M, pos, w, d, rotY = 0, strength = 1) {
  b.plane(M.shadow, [pos[0], pos[1] + 0.018, pos[2]], w * 1.35 * strength, d * 1.35 * strength, rotY);
}

export function sofa(b, M, { pos, rotY = 0, length = 2.6, depth = 1.0, mat, pillow }) {
  b.group(pos, rotY, () => {
    const L = length;
    const D = depth;
    b.box(M.blackMetal, [-L / 2 + 0.15, 0, -D / 2 + 0.15], [L / 2 - 0.15, 0.08, D / 2 - 0.15]);
    b.rbox(mat, [0, 0.25, 0], [L, 0.3, D], 0.05);
    const inner = L - 0.4;
    const n = inner > 2 ? 3 : 2;
    const cw = inner / n;
    for (let i = 0; i < n; i++) {
      const x = -inner / 2 + cw * (i + 0.5);
      b.rbox(mat, [x, 0.47, 0.09], [cw - 0.02, 0.16, D - 0.3], 0.07, 0, 2);
      b.rbox(mat, [x, 0.74, -D / 2 + 0.3], [cw - 0.03, 0.44, 0.2], 0.09, 0, 2);
    }
    b.rbox(mat, [0, 0.58, -D / 2 + 0.11], [L, 0.62, 0.22], 0.07);
    b.rbox(mat, [-L / 2 + 0.1, 0.48, 0.0], [0.2, 0.36, D], 0.08);
    b.rbox(mat, [L / 2 - 0.1, 0.48, 0.0], [0.2, 0.36, D], 0.08);
    if (pillow) {
      b.rbox(pillow, [-inner / 2 + 0.3, 0.72, -D / 2 + 0.45], [0.45, 0.4, 0.14], 0.07, 0.25, 2);
      b.rbox(pillow, [inner / 2 - 0.3, 0.72, -D / 2 + 0.45], [0.45, 0.4, 0.14], 0.07, -0.25, 2);
    }
  });
  shadow(b, M, pos, rotY % Math.PI === 0 ? length : depth, rotY % Math.PI === 0 ? depth : length);
}

export function loungeChair(b, M, { pos, rotY = 0, mat, legs }) {
  b.group(pos, rotY, () => {
    for (const [x, z] of [
      [-0.3, -0.3],
      [0.3, -0.3],
      [-0.3, 0.3],
      [0.3, 0.3],
    ]) {
      b.cyl(legs || M.walnut, [x, 0.1, z], 0.018, 0.014, 0.2, 10);
    }
    b.rbox(mat, [0, 0.3, 0], [0.82, 0.22, 0.8], 0.08, 0, 2);
    b.rbox(mat, [0, 0.62, -0.32], [0.82, 0.55, 0.18], 0.08, 0, 2);
    b.rbox(mat, [-0.37, 0.5, 0.02], [0.12, 0.26, 0.72], 0.05);
    b.rbox(mat, [0.37, 0.5, 0.02], [0.12, 0.26, 0.72], 0.05);
  });
  shadow(b, M, pos, 0.9, 0.9, rotY);
}

export function diningChair(b, M, { pos, rotY = 0, mat }) {
  b.group(pos, rotY, () => {
    for (const [x, z] of [
      [-0.2, -0.2],
      [0.2, -0.2],
      [-0.2, 0.2],
      [0.2, 0.2],
    ]) {
      b.box(M.walnut, [x - 0.018, 0, z - 0.018], [x + 0.018, 0.46, z + 0.018]);
    }
    b.rbox(mat, [0, 0.5, 0.01], [0.5, 0.09, 0.48], 0.035);
    b.rbox(mat, [0, 0.82, -0.21], [0.48, 0.56, 0.07], 0.035);
  });
  shadow(b, M, pos, 0.5, 0.5, rotY);
}

export function stool(b, M, { pos, rotY = 0, mat }) {
  b.group(pos, rotY, () => {
    b.cyl(M.blackMetal, [0, 0.33, 0], 0.025, 0.03, 0.66, 12);
    b.cyl(M.blackMetal, [0, 0.01, 0], 0.2, 0.2, 0.02, 24);
    b.torus(M.blackMetal, [0, 0.3, 0], 0.16, 0.008);
    b.cyl(mat, [0, 0.69, 0], 0.2, 0.19, 0.07, 24);
    b.rbox(mat, [0, 0.86, -0.17], [0.34, 0.24, 0.05], 0.025);
  });
}

export function rectTable(b, M, { pos, rotY = 0, w, d, h = 0.76, top, legs }) {
  b.group(pos, rotY, () => {
    b.rbox(top, [0, h - 0.025, 0], [w, 0.05, d], 0.012);
    const inset = 0.12;
    for (const [x, z] of [
      [-w / 2 + inset, -d / 2 + inset],
      [w / 2 - inset, -d / 2 + inset],
      [-w / 2 + inset, d / 2 - inset],
      [w / 2 - inset, d / 2 - inset],
    ]) {
      b.box(legs || top, [x - 0.035, 0, z - 0.035], [x + 0.035, h - 0.05, z + 0.035]);
    }
    b.box(legs || top, [-w / 2 + inset, h - 0.12, -d / 2 + inset], [w / 2 - inset, h - 0.05, -d / 2 + inset + 0.03]);
    b.box(legs || top, [-w / 2 + inset, h - 0.12, d / 2 - inset - 0.03], [w / 2 - inset, h - 0.05, d / 2 - inset]);
  });
  shadow(b, M, pos, w, d, rotY);
}

export function roundTable(b, M, { pos, r = 0.6, h = 0.75, top, base }) {
  b.group(pos, 0, () => {
    b.cyl(top, [0, h - 0.02, 0], r, r, 0.04, 40);
    b.cyl(base || top, [0, h / 2, 0], 0.07, 0.1, h - 0.04, 20);
    b.cyl(base || top, [0, 0.025, 0], r * 0.5, r * 0.55, 0.05, 32);
  });
  shadow(b, M, pos, r * 2, r * 2);
}

export function coffeeTable(b, M, { pos, r = 0.55, h = 0.38, mat }) {
  b.group(pos, 0, () => {
    b.cyl(mat, [0, h / 2, 0], r, r * 0.92, h, 48);
  });
  shadow(b, M, pos, r * 2, r * 2);
}

export function bed(b, M, { pos, rotY = 0, width = 1.9, length = 2.1, frame, headboard, duvet, sheet, pillows, throwMat }) {
  b.group(pos, rotY, () => {
    // Bed faces +z: headboard at -z.
    const W = width;
    const L = length;
    b.rbox(frame, [0, 0.18, 0], [W + 0.08, 0.3, L], 0.03);
    b.rbox(sheet, [0, 0.43, 0.02], [W, 0.22, L - 0.08], 0.06, 0, 2);
    b.rbox(duvet, [0, 0.55, 0.22], [W + 0.06, 0.08, L - 0.48], 0.04, 0, 2);
    b.rbox(duvet, [0, 0.36, L / 2 - 0.02], [W + 0.06, 0.36, 0.06], 0.03);
    b.rbox(duvet, [-W / 2 - 0.02, 0.36, 0.22], [0.06, 0.36, L - 0.48], 0.03);
    b.rbox(duvet, [W / 2 + 0.02, 0.36, 0.22], [0.06, 0.36, L - 0.48], 0.03);
    if (throwMat) b.rbox(throwMat, [0, 0.6, L / 2 - 0.38], [W + 0.1, 0.05, 0.5], 0.025);
    const pw = W / 2 - 0.08;
    for (const s of [-1, 1]) {
      b.rbox(sheet, [s * (pw / 2 + 0.04), 0.66, -L / 2 + 0.25], [pw, 0.22, 0.16], 0.08, 0, 2);
      b.rbox(pillows, [s * (pw / 2 + 0.04), 0.66, -L / 2 + 0.42], [pw * 0.82, 0.32, 0.13], 0.07, 0, 2);
    }
    b.rbox(headboard, [0, 0.75, -L / 2 - 0.05], [W + 0.3, 1.5, 0.12], 0.05, 0, 3);
  });
  shadow(b, M, pos, Math.abs(Math.sin(rotY)) > 0.5 ? length : width + 0.2, Math.abs(Math.sin(rotY)) > 0.5 ? width + 0.2 : length, 0);
}

export function nightstand(b, M, { pos, rotY = 0, mat, lamp = true }) {
  b.group(pos, rotY, () => {
    b.rbox(mat, [0, 0.29, 0], [0.55, 0.58, 0.42], 0.015);
    b.box(M.brass, [-0.08, 0.38, 0.209], [0.08, 0.395, 0.222]);
    if (lamp) tableLamp(b, M, [0, 0.58, -0.02]);
  });
  shadow(b, M, pos, 0.55, 0.42, rotY);
}

export function tableLamp(b, M, at, scale = 1) {
  b.group(at, 0, () => {
    b.sphere(M.ceramic, [0, 0.14 * scale, 0], 0.12 * scale, [1, 1.15, 1]);
    b.cyl(M.brass, [0, 0.33 * scale, 0], 0.008, 0.008, 0.16 * scale, 8);
    b.cyl(M.shade, [0, 0.44 * scale, 0], 0.13 * scale, 0.17 * scale, 0.22 * scale, 32);
  });
}

export function floorLamp(b, M, { pos }) {
  b.group(pos, 0, () => {
    b.cyl(M.blackMetal, [0, 0.015, 0], 0.16, 0.16, 0.03, 24);
    b.cyl(M.brass, [0, 0.75, 0], 0.012, 0.012, 1.5, 8);
    b.cyl(M.shade, [0, 1.55, 0], 0.18, 0.23, 0.3, 32);
  });
  shadow(b, M, pos, 0.4, 0.4);
}

export function plant(b, M, { pos, height = 1.6, pot = "ceramic", seed = 1 }) {
  const r = rng(seed);
  b.group(pos, 0, () => {
    const potH = Math.min(0.5, height * 0.3);
    b.cyl(M[pot] || M.ceramic, [0, potH / 2, 0], 0.22, 0.17, potH, 28);
    b.cyl(M.soil, [0, potH - 0.01, 0], 0.2, 0.2, 0.02, 20);
    const stemH = height - potH;
    b.cyl(M.stem, [0, potH + stemH * 0.4, 0], 0.015, 0.02, stemH * 0.8, 6);
    const leaves = Math.round(10 + height * 8);
    for (let i = 0; i < leaves; i++) {
      const t = 0.35 + r() * 0.65;
      const ang = r() * Math.PI * 2;
      const rad = 0.08 + r() * 0.28 * (1 - t * 0.3);
      const y = potH + stemH * t;
      const s = 0.09 + r() * 0.07;
      b.sphere(r() > 0.5 ? M.leaf : M.leaf2, [Math.cos(ang) * rad, y, Math.sin(ang) * rad], s, [1.4, 0.5, 1], 1);
    }
  });
  shadow(b, M, pos, 0.5, 0.5);
}

export function vase(b, M, { pos, mat, branches = true, seed = 3 }) {
  const r = rng(seed);
  b.group(pos, 0, () => {
    b.sphere(mat || M.ceramic, [0, 0.16, 0], 0.13, [1, 1.3, 1]);
    b.cyl(mat || M.ceramic, [0, 0.33, 0], 0.045, 0.06, 0.08, 16);
    if (branches) {
      for (let i = 0; i < 6; i++) {
        const a = r() * Math.PI * 2;
        const tilt = 0.2 + r() * 0.35;
        const len = 0.45 + r() * 0.35;
        b.cyl(M.stem, [Math.cos(a) * Math.sin(tilt) * len * 0.5, 0.35 + Math.cos(tilt) * len * 0.5, Math.sin(a) * Math.sin(tilt) * len * 0.5], 0.006, 0.009, len, 5, [
          Math.sin(a) * tilt,
          0,
          -Math.cos(a) * tilt,
        ]);
        for (let k = 0; k < 4; k++) {
          const tt = 0.4 + k * 0.17;
          b.sphere(M.leaf2, [
            Math.cos(a) * Math.sin(tilt) * len * tt + (r() - 0.5) * 0.06,
            0.35 + Math.cos(tilt) * len * tt,
            Math.sin(a) * Math.sin(tilt) * len * tt + (r() - 0.5) * 0.06,
          ], 0.035, [1.5, 0.4, 1], 0);
        }
      }
    }
  });
}

/** Wall art: canvas in a slim frame. Canvas faces +z in the local frame. */
export function art(b, M, { pos, rotY = 0, w, h, canvas, frame }) {
  b.group(pos, rotY, () => {
    const f = 0.03;
    b.box(frame || M.blackMetal, [-w / 2 - f, -h / 2 - f, 0], [w / 2 + f, h / 2 + f, 0.035]);
    b.box(canvas, [-w / 2, -h / 2, 0.035], [w / 2, h / 2, 0.04]);
  });
}

export function rugAt(b, M, { pos, w, d, mat, rotY = 0 }) {
  b.group(pos, rotY, () => {
    b.box(mat, [-w / 2, 0, -d / 2], [w / 2, 0.012, d / 2]);
  });
}

/** Shelf unit (faces +z) filled with books and objects. */
export function bookshelf(b, M, { pos, rotY = 0, w, h, d = 0.36, shelves = 5, frame, seed = 9, fill = 0.75 }) {
  const r = rng(seed);
  const books = M.books;
  b.group(pos, rotY, () => {
    const t = 0.03;
    b.box(frame, [-w / 2, 0, -d / 2], [-w / 2 + t, h, d / 2]);
    b.box(frame, [w / 2 - t, 0, -d / 2], [w / 2, h, d / 2]);
    b.box(frame, [-w / 2, h - t, -d / 2], [w / 2, h, d / 2]);
    b.box(frame, [-w / 2, 0, -d / 2], [w / 2, 0.1, d / 2]);
    b.box(frame, [-w / 2, 0, -d / 2], [w / 2, h, -d / 2 + 0.015]);
    const bays = Math.max(1, Math.round(w / 0.9));
    const bw = (w - t * 2) / bays;
    for (let i = 1; i < bays; i++) {
      const x = -w / 2 + t + bw * i;
      b.box(frame, [x - t / 2, 0.1, -d / 2], [x + t / 2, h - t, d / 2]);
    }
    const sh = (h - 0.1 - t) / shelves;
    for (let s = 0; s < shelves; s++) {
      const y = 0.1 + sh * s;
      if (s > 0) b.box(frame, [-w / 2 + t, y - t / 2, -d / 2], [w / 2 - t, y + t / 2, d / 2]);
      for (let bay = 0; bay < bays; bay++) {
        const x0 = -w / 2 + t + bw * bay + (bay > 0 ? t / 2 : 0) + 0.02;
        const x1 = x0 + bw - t - 0.04;
        let x = x0;
        const mode = r();
        if (mode < 1 - fill) {
          // Decorative object instead of books.
          const cx = (x0 + x1) / 2;
          if (r() > 0.5) b.sphere(M.ceramic, [cx, y + t / 2 + 0.11, 0], 0.1, [1, 1.1, 1]);
          else b.cyl(M.ceramicDark, [cx, y + t / 2 + 0.09, 0], 0.07, 0.09, 0.18, 20);
          continue;
        }
        const limit = x0 + (x1 - x0) * (0.55 + r() * 0.45);
        while (x < limit) {
          const bwid = 0.022 + r() * 0.03;
          const bh = Math.min(sh - 0.05, 0.2 + r() * 0.12);
          const bd = d - 0.06 - r() * 0.05;
          b.box(books[Math.floor(r() * books.length)], [x, y + t / 2, -d / 2 + 0.03], [x + bwid, y + t / 2 + bh, -d / 2 + 0.03 + bd]);
          x += bwid + 0.002;
        }
        if (r() > 0.5 && x1 - x > 0.25) {
          // Horizontal stack.
          let yy = y + t / 2;
          for (let k = 0; k < 3; k++) {
            const bh = 0.03 + r() * 0.02;
            b.box(books[Math.floor(r() * books.length)], [x1 - 0.22, yy, -d / 2 + 0.05], [x1 - 0.01, yy + bh, d / 2 - 0.05]);
            yy += bh;
          }
        }
      }
    }
  });
}

/** Brass ring chandelier with glowing candles. */
export function chandelier(b, M, { pos, ceilingY, r = 0.55, tiers = 2 }) {
  b.group(pos, 0, () => {
    const top = ceilingY - pos[1];
    b.cyl(M.brass, [0, top / 2, 0], 0.012, 0.012, top, 8);
    b.cyl(M.brass, [0, top - 0.02, 0], 0.1, 0.1, 0.04, 24);
    for (let t = 0; t < tiers; t++) {
      const rr = r * (1 - t * 0.35);
      const y = t * 0.32;
      b.torus(M.brass, [0, y, 0], rr, 0.018);
      const n = Math.round(rr * 18);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = Math.cos(a) * rr;
        const z = Math.sin(a) * rr;
        b.cyl(M.brass, [x, y + 0.03, z], 0.018, 0.022, 0.06, 10);
        b.sphere(M.bulb, [x, y + 0.11, z], 0.035, [1, 1.5, 1], 1);
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        b.cyl(M.brass, [(Math.cos(a) * rr) / 2, y, (Math.sin(a) * rr) / 2], 0.006, 0.006, rr, 6, [0, -a, Math.PI / 2]);
      }
    }
  });
}

export function pendant(b, M, { pos, ceilingY, r = 0.2, mat }) {
  b.group(pos, 0, () => {
    const top = ceilingY - pos[1];
    b.cyl(M.blackMetal, [0, top / 2, 0], 0.005, 0.005, top, 6);
    b.cyl(M.blackMetal, [0, top - 0.015, 0], 0.06, 0.06, 0.03, 16);
    b.cyl(mat || M.brass, [0, 0.06, 0], 0.04, r, 0.16, 32);
    b.cyl(M.bulb, [0, -0.025, 0], r * 0.92, r * 0.92, 0.01, 32);
  });
}

export function globeChandelier(b, M, { pos, ceilingY, length = 1.6 }) {
  b.group(pos, 0, () => {
    const top = ceilingY - pos[1];
    for (const s of [-1, 1]) b.cyl(M.brass, [0, top / 2, (s * length) / 3], 0.006, 0.006, top, 6);
    b.box(M.brass, [-0.02, -0.02, -length / 2], [0.02, 0.02, length / 2]);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const z = -length / 2 + (length / (n - 1)) * i;
      b.cyl(M.brass, [0, -0.05, z], 0.006, 0.006, 0.1, 6);
      b.sphere(M.globe, [0, -0.15, z], 0.085, [1, 1, 1], 2);
    }
  });
}

/** Linen drape panel hanging from the ceiling line. Faces +z. */
export function drape(b, M, { pos, rotY = 0, w = 0.4, h }) {
  b.group(pos, rotY, () => {
    const folds = 4;
    for (let i = 0; i < folds; i++) {
      const x = -w / 2 + (w / folds) * (i + 0.5);
      b.rbox(M.drape, [x, h / 2, i % 2 ? 0.02 : -0.01], [w / folds + 0.03, h, 0.07], 0.03, 0, 1);
    }
  });
}
