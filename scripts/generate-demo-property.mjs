#!/usr/bin/env node
// Generates the demo property capture:
//   public/demo/sheridan-road.glb          — textured 3D model (+ embedded manifest)
//   src/lib/demo/sheridan-road.manifest.json — floors / rooms / waypoints / links
//
// This is the stand-in for the future iPhone capture pipeline output.
// Run with: npm run generate:demo

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHouse } from "./demo-house/house.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const t0 = Date.now();
const { builder, manifest } = buildHouse();
const { glb, triangles } = await builder.toGLB({
  name: "1234 Sheridan Road",
  extras: { atrium: manifest },
});

const glbPath = path.join(root, "public/demo/sheridan-road.glb");
const manifestPath = path.join(root, "src/lib/demo/sheridan-road.manifest.json");
fs.mkdirSync(path.dirname(glbPath), { recursive: true });
fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(glbPath, glb);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(
  `Demo property generated in ${((Date.now() - t0) / 1000).toFixed(1)}s: ` +
    `${(glb.byteLength / 1024 / 1024).toFixed(2)} MB, ${Math.round(triangles).toLocaleString()} triangles, ` +
    `${builder.materials.size} materials, ${builder.lights.length} lights`,
);
