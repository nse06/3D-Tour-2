"""SPZ (Niantic's compressed Gaussian splat format, version 3): what the tour viewer loads.

Header (little-endian): magic "NGSP" (0x5053474E), version 3, splat count, SH degree, fractional
bits, flags, reserved; then per splat, field by field: positions (24-bit fixed point x3), alphas
(u8), colors (SH band 0 as u8: value * 0.15 + 0.5), log scales (u8: (s + 10) * 16), rotations, and
the higher SH bands (u8: v * 128 + 128, coefficient by coefficient, RGB inside). The whole thing is
gzipped.

Rotations ("smallest three", 4 bytes): the quaternion (x, y, z, w) turned so its largest component
is positive; the top 2 bits say which component that is, and the other three follow as 10 bits each
(sign bit, then 9 bits of |v| / sqrt(1/2)), the lowest index in the highest bits. Version 2 stored
x, y, z in a byte each, which gets splats turned nearly 180 degrees noticeably wrong.
"""

from __future__ import annotations

import gzip
import struct

import numpy as np

MAGIC = 0x5053474E
VERSION = 3
FRACTIONAL_BITS = 12
COLOR_SCALE = 0.15


def write(path, means, log_scales, quats_wxyz, opacity_logits, sh, sh_degree: int, min_opacity: float = 0.005) -> dict:
    """Writes splats (numpy arrays; sh is (N, K, 3)) and returns what went in."""
    opacity = 1 / (1 + np.exp(-opacity_logits.astype(np.float64)))
    keep = (opacity >= min_opacity) & np.isfinite(means).all(1) & np.isfinite(log_scales).all(1)
    means, log_scales, quats_wxyz, sh, opacity = means[keep], log_scales[keep], quats_wxyz[keep], sh[keep], opacity[keep]
    n = len(means)
    degree = max(0, min(sh_degree, int(round(np.sqrt(sh.shape[1]))) - 1, 3))

    pos = np.round(means.astype(np.float64) * (1 << FRACTIONAL_BITS)).astype(np.int64)
    pos = np.clip(pos, -(1 << 23), (1 << 23) - 1) & 0xFFFFFF
    pos_bytes = np.stack([pos & 255, (pos >> 8) & 255, (pos >> 16) & 255], axis=-1).astype(np.uint8).reshape(n, 9)
    alphas = np.clip(np.round(opacity * 255), 0, 255).astype(np.uint8)
    colors = np.clip(np.round((sh[:, 0] * COLOR_SCALE + 0.5) * 255), 0, 255).astype(np.uint8)
    scales = np.clip(np.round((log_scales + 10) * 16), 0, 255).astype(np.uint8)
    rotations = pack_rotations(quats_wxyz)
    parts = [
        struct.pack("<IIIBBBB", MAGIC, VERSION, n, degree, FRACTIONAL_BITS, 0, 0),
        pos_bytes.tobytes(),
        alphas.tobytes(),
        colors.tobytes(),
        scales.tobytes(),
        rotations.tobytes(),
    ]
    if degree > 0:
        rest = sh[:, 1 : (degree + 1) ** 2]
        parts.append(np.clip(np.round(rest * 128 + 128), 0, 255).astype(np.uint8).reshape(n, -1).tobytes())
    raw = b"".join(parts)
    data = gzip.compress(raw, compresslevel=9)
    with open(path, "wb") as f:
        f.write(data)
    return {"splats": int(n), "shDegree": degree, "bytes": len(data), "rawBytes": len(raw)}


def read(path) -> dict:
    """The splats in an SPZ file (version 3), decoded back to floats."""
    raw = gzip.decompress(open(path, "rb").read())
    magic, version, n, degree, frac, _, _ = struct.unpack_from("<IIIBBBB", raw, 0)
    if magic != MAGIC or version != VERSION:
        raise ValueError(f"not an SPZ v3 file: {magic:#x} v{version}")
    o = 16

    def take(count):
        nonlocal o
        out = np.frombuffer(raw, dtype=np.uint8, count=count, offset=o)
        o += count
        return out

    pb = take(n * 9).reshape(n, 3, 3).astype(np.int64)
    pos = pb[..., 0] | (pb[..., 1] << 8) | (pb[..., 2] << 16)
    pos = np.where(pos >= 1 << 23, pos - (1 << 24), pos)
    alphas = take(n).astype(np.float64) / 255
    colors = take(n * 3).reshape(n, 3).astype(np.float64)
    scales = take(n * 3).reshape(n, 3).astype(np.float64) / 16 - 10
    xyzw = unpack_rotations(take(n * 4).view("<u4"))
    coefficients = (degree + 1) ** 2 - 1
    rest = (take(n * coefficients * 3).reshape(n, coefficients, 3).astype(np.float64) - 128) / 128 if degree else np.zeros((n, 0, 3))
    return {
        "means": pos / (1 << frac),
        "opacity": alphas,
        "sh0": (colors / 255 - 0.5) / COLOR_SCALE,
        "log_scales": scales,
        "quats_wxyz": np.concatenate([xyzw[:, 3:], xyzw[:, :3]], 1),
        "sh_rest": rest,
        "sh_degree": degree,
    }


def pack_rotations(quats_wxyz: np.ndarray) -> np.ndarray:
    """Smallest-three rotations, 4 little-endian bytes per splat."""
    q = quats_wxyz.astype(np.float64)
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    xyzw = np.concatenate([q[:, 1:], q[:, :1]], 1)
    largest = np.argmax(np.abs(xyzw), axis=1)
    rows = np.arange(len(q))
    xyzw = np.where(xyzw[rows, largest][:, None] < 0, -xyzw, xyzw)
    packed = largest.astype(np.uint32) << 30
    # The other three in ascending index order: bits 20-29, 10-19, 0-9.
    others = np.array([[j for j in range(4) if j != i] for i in range(4)])[largest]
    for slot, shift in enumerate((20, 10, 0)):
        v = xyzw[rows, others[:, slot]]
        magnitude = np.clip(np.round(np.abs(v) / np.sqrt(0.5) * 511), 0, 511).astype(np.uint32)
        packed |= (((v < 0).astype(np.uint32) << 9) | magnitude) << shift
    return packed.astype("<u4").view(np.uint8)


def unpack_rotations(packed: np.ndarray) -> np.ndarray:
    """(x, y, z, w) back from smallest-three words, as three.js's SPZLoader decodes them."""
    packed = packed.astype(np.uint32)
    largest = packed >> 30
    out = np.zeros((len(packed), 4))
    others = np.array([[j for j in range(4) if j != i] for i in range(4)])[largest]
    rows = np.arange(len(packed))
    for slot, shift in enumerate((20, 10, 0)):
        field = (packed >> shift) & 1023
        value = np.sqrt(0.5) * (field & 511) / 511
        out[rows, others[:, slot]] = np.where(field & 512, -value, value)
    out[rows, largest] = np.sqrt(np.clip(1 - (out**2).sum(1), 0, 1))
    return out
