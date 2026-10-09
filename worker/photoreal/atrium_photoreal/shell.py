"""The rooms' shell (walls, floors, ceilings), and the rules training keeps with it.

Photos only say what a surface looks like from where they were taken, so a splat can sit anywhere
that looks right from those spots: from closer, or from the side, it shows as a smear, a needle or a
blob hanging off the wall. The scan measured the walls, floors and ceilings, and the painted model the
seeds lie on is built from them, so training keeps the splats there flat: moved onto the plane, turned
to lie in it and made thin. Walls then stay solid and crisp from any viewpoint, and the view-dependent
look of a room (reflections, the view out of a window) is left to the splats that aren't on the shell.

Planes come from the rooms in cameras.json (floor and ceiling heights, the floor outline), each
checked against the seeds: a plane counts where seeds lie on it, facing the same way. So an outline
edge between two open rooms (no wall there) and a doorway or window in a wall (no seeds there) are
left alone.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import torch
import torch.nn.functional as F

# How close a seed must be to a plane, and to which side it must face, to count as on it.
ON_PLANE = 0.015
FACING = 0.9


class SurfaceIndex:
    """Which points lie within about a cell of the given points (of the same group, if grouped):
    a hash of the voxels around them."""

    BITS = 17  # per axis: ±65,536 cells

    def __init__(self, points: torch.Tensor, cell: float, groups: torch.Tensor | None = None):
        self.cell = cell
        device = points.device
        offsets = torch.stack(torch.meshgrid(*[torch.tensor([-1, 0, 1], device=device)] * 3, indexing="ij"), -1).reshape(-1, 3)
        cells = torch.floor(points / cell).long()
        g = torch.zeros(len(points), dtype=torch.long, device=device) if groups is None else groups.long()
        keys = self._key(cells[:, None, :] + offsets[None], g[:, None].expand(-1, len(offsets)))
        self.keys = torch.unique(keys.reshape(-1))

    @classmethod
    def _key(cls, c: torch.Tensor, g: torch.Tensor) -> torch.Tensor:
        c = (c + (1 << (cls.BITS - 1))).clamp(0, (1 << cls.BITS) - 1)
        return (g << (3 * cls.BITS)) | (c[..., 0] << (2 * cls.BITS)) | (c[..., 1] << cls.BITS) | c[..., 2]

    def near(self, points: torch.Tensor, groups: torch.Tensor | None = None) -> torch.Tensor:
        if not len(self.keys) or not len(points):
            return torch.zeros(len(points), dtype=torch.bool, device=points.device)
        g = torch.zeros(len(points), dtype=torch.long, device=points.device) if groups is None else groups.long()
        keys = self._key(torch.floor(points / self.cell).long(), g)
        i = torch.searchsorted(self.keys, keys).clamp(max=len(self.keys) - 1)
        return self.keys[i] == keys


@dataclass
class Shell:
    """Planes (walls first, then floors and ceilings): signed distance of p = p · normal − offset,
    positive inside the room."""

    normal: torch.Tensor  # (P, 3) unit, pointing into the room
    offset: torch.Tensor  # (P,)
    # Walls: where along the wall (from `wall_start`, in x and z) and how high.
    wall_start: torch.Tensor  # (W, 2)
    wall_dir: torch.Tensor  # (W, 2) unit
    wall_len: torch.Tensor  # (W,)
    wall_y: torch.Tensor  # (W, 2) bottom and top
    # Floors and ceilings: over which room's outline.
    flat_room: torch.Tensor  # (H,)
    polygons: list[torch.Tensor]  # per room, (V, 2) in x and z
    # The seeds on each plane, by plane: where it counts.
    support: SurfaceIndex
    names: list[str]

    @property
    def walls(self) -> int:
        return len(self.wall_len)

    @property
    def flats(self) -> int:
        return len(self.flat_room)

    def to(self, device: torch.device | str) -> "Shell":
        moved = {k: getattr(self, k).to(device) for k in ("normal", "offset", "wall_start", "wall_dir", "wall_len", "wall_y", "flat_room")}
        support = SurfaceIndex.__new__(SurfaceIndex)
        support.cell, support.keys = self.support.cell, self.support.keys.to(device)
        return Shell(**moved, polygons=[p.to(device) for p in self.polygons], support=support, names=self.names)


def inside_polygon(xz: torch.Tensor, poly: torch.Tensor) -> torch.Tensor:
    """(N,) whether each (x, z) is inside the polygon (even-odd rule)."""
    x, z = xz[:, :1], xz[:, 1:]
    a, b = poly, poly.roll(-1, 0)
    dz = b[:, 1] - a[:, 1]
    dz = torch.where(dz.abs() > 1e-12, dz, torch.full_like(dz, 1e-12))
    crosses = (a[:, 1] > z) != (b[:, 1] > z)  # (N, V)
    at = a[:, 0] + (z - a[:, 1]) * (b[:, 0] - a[:, 0]) / dz
    return ((crosses & (x < at)).sum(dim=1) % 2) == 1


def from_capture(rooms: list[dict], seeds_xyz: np.ndarray, seeds_normal: np.ndarray, spacing: float = 0.03, cell: float = 0.05) -> Shell | None:
    """The shell of the rooms in cameras.json (floorY, ceilingY, floor outline in x and z), where the
    seeds confirm it. None if nothing does."""
    pts = torch.from_numpy(np.ascontiguousarray(seeds_xyz, dtype=np.float32))
    nrm = F.normalize(torch.from_numpy(np.ascontiguousarray(seeds_normal, dtype=np.float32)), dim=1)
    walls: list[tuple] = []
    flats: list[tuple] = []
    polygons: list[torch.Tensor] = []
    for room in rooms:
        try:
            poly = np.asarray(room.get("polygon") or [], dtype=np.float64).reshape(-1, 2)
            floor, ceiling = float(room["floorY"]), float(room["ceilingY"])
        except (KeyError, TypeError, ValueError):
            continue
        if len(poly) < 3 or not np.isfinite(poly).all() or not (math.isfinite(floor) and math.isfinite(ceiling) and ceiling - floor > 1.0):
            continue
        r = len(polygons)
        name = str(room.get("name") or f"room {r + 1}")
        polygons.append(torch.tensor(poly, dtype=torch.float32))
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            length = float(np.hypot(*(b - a)))
            if length < 0.2:
                continue
            d = (b - a) / length
            # The normal into the room: whichever side of the edge's middle is inside the outline.
            n = np.array([-d[1], d[0]])
            probe = torch.tensor(np.array([(a + b) / 2 + n * 0.05]), dtype=torch.float32)
            if not inside_polygon(probe, polygons[-1])[0]:
                n = -n
            walls.append((f"{name} wall {i + 1}", a, d, length, n, floor, ceiling))
        flats.append((name, r, floor, 1.0))
        flats.append((name, r, ceiling, -1.0))

    normals, offsets, names, keep_walls, keep_flats, members = [], [], [], [], [], []

    def settle(normal: np.ndarray, base: float, near: torch.Tensor, area: float) -> float | None:
        """The plane's offset where its seeds are (their median), if enough of them lie on it."""
        n = torch.tensor(normal, dtype=torch.float32)
        facing = (nrm @ n) > FACING
        signed = pts @ n - base
        found = near & facing & (signed.abs() < 0.1)
        count = int(found.sum())
        # A fair share of the plane seen and painted: a wall hidden behind wardrobes isn't worth it.
        if count < max(20, 0.03 * area / spacing**2):
            return None
        shift = float(signed[found].median())
        on = found & ((signed - shift).abs() < ON_PLANE)
        members.append(on)
        return base + shift

    for name, a, d, length, n, floor, ceiling in walls:
        normal = np.array([n[0], 0.0, n[1]])
        base = float(n[0] * a[0] + n[1] * a[1])
        along = (pts[:, 0] - a[0]) * d[0] + (pts[:, 2] - a[1]) * d[1]
        near = (along > -0.05) & (along < length + 0.05) & (pts[:, 1] > floor - 0.05) & (pts[:, 1] < ceiling + 0.05)
        offset = settle(normal, base, near, length * (ceiling - floor))
        if offset is None:
            continue
        shift = offset - base
        keep_walls.append((np.asarray(a) + n * shift, d, length, (floor, ceiling)))
        normals.append(normal)
        offsets.append(offset)
        names.append(name)
    for name, r, y, up in flats:
        normal = np.array([0.0, up, 0.0])
        near = inside_polygon(pts[:, [0, 2]], polygons[r])
        p, q = polygons[r], polygons[r].roll(-1, 0)
        area = abs(0.5 * float((p[:, 0] * q[:, 1] - p[:, 1] * q[:, 0]).sum()))
        offset = settle(normal, y * up, near, area)
        if offset is None:
            continue
        keep_flats.append(r)
        normals.append(normal)
        offsets.append(offset)
        names.append(f"{name} {'floor' if up > 0 else 'ceiling'}")
    if not normals:
        return None

    # Support: each plane's seeds, keyed by the plane.
    which = torch.cat([torch.nonzero(m)[:, 0] for m in members])
    plane = torch.cat([torch.full((int(m.sum()),), k, dtype=torch.long) for k, m in enumerate(members)])
    support = SurfaceIndex(pts[which], cell, groups=plane)

    def t(values, shape):
        return torch.tensor(np.asarray(values, dtype=np.float32).reshape(shape))

    return Shell(
        normal=t(normals, (-1, 3)),
        offset=t(offsets, (-1,)),
        wall_start=t([w[0] for w in keep_walls], (-1, 2)),
        wall_dir=t([w[1] for w in keep_walls], (-1, 2)),
        wall_len=t([w[2] for w in keep_walls], (-1,)),
        wall_y=t([w[3] for w in keep_walls], (-1, 2)),
        flat_room=torch.tensor(keep_flats, dtype=torch.long),
        polygons=polygons,
        support=support,
        names=names,
    )


def nearest_plane(shell: Shell, means: torch.Tensor, margin: float = 0.05, chunk: int = 1 << 17) -> tuple[torch.Tensor, torch.Tensor]:
    """For each point: the signed distance to the nearest plane it lies over (positive inside the
    room) and that plane's index; (inf, -1) where it lies over none."""
    W = shell.walls
    out_d, out_k = [], []
    for m in means.split(chunk):
        signed = m @ shell.normal.T - shell.offset  # (n, P)
        over = []
        if W:
            along = m[:, [0, 2]] @ shell.wall_dir.T - (shell.wall_start * shell.wall_dir).sum(-1)
            y = m[:, 1:2]
            over.append((along > -margin) & (along < shell.wall_len + margin) & (y > shell.wall_y[:, 0] - margin) & (y < shell.wall_y[:, 1] + margin))
        if shell.flats:
            inside = torch.stack([inside_polygon(m[:, [0, 2]], p) for p in shell.polygons], 1)  # (n, R)
            over.append(inside[:, shell.flat_room])
        dist = torch.where(torch.cat(over, 1), signed.abs(), torch.full_like(signed, float("inf")))
        d, k = dist.min(dim=1)
        hit = torch.isfinite(d)
        out_d.append(torch.where(hit, signed.gather(1, k[:, None])[:, 0], d))
        out_k.append(torch.where(hit, k, torch.full_like(k, -1)))
    if not out_d:
        return torch.zeros(0, device=means.device), torch.zeros(0, dtype=torch.long, device=means.device)
    return torch.cat(out_d), torch.cat(out_k)


def quat_to_matrix(q: torch.Tensor) -> torch.Tensor:
    """(N, 4) wxyz quaternions (any length) → (N, 3, 3) rotations; column i is local axis i."""
    w, x, y, z = F.normalize(q, dim=-1).unbind(-1)
    return torch.stack(
        [
            1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
            2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
            2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
        ],
        -1,
    ).reshape(-1, 3, 3)  # fmt: skip


def quat_multiply(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """Hamilton product a ⊗ b of (N, 4) wxyz quaternions: the rotation b, then a."""
    aw, ax, ay, az = a.unbind(-1)
    bw, bx, by, bz = b.unbind(-1)
    return torch.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        -1,
    )


def rotation_between(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """(N, 4) wxyz quaternions turning unit vectors a onto unit vectors b (never opposite here)."""
    return F.normalize(torch.cat([1 + (a * b).sum(-1, keepdim=True), torch.cross(a, b, dim=-1)], -1), dim=-1)


@torch.no_grad()
def snap_to_shell(splats, shell: Shell, within: float = 0.025, thickness: float = 0.002) -> int:
    """Splats on a wall, floor or ceiling (within `within` m of a plane, where seeds lie on it):
    moved onto the plane, turned so their thinnest axis is the plane's normal, and made at most
    `thickness` m thick. Returns how many."""
    means = splats["means"]
    signed, k = nearest_plane(shell, means)
    on = (signed.abs() < within) & (k >= 0)
    idx = on.nonzero()[:, 0]
    if len(idx):
        idx = idx[shell.support.near(means[idx], k[idx])]
    if not len(idx):
        return 0
    n = shell.normal[k[idx]]
    means[idx] = means[idx] - signed[idx, None] * n
    quats, scales = splats["quats"][idx], splats["scales"][idx]
    thin = scales.argmin(dim=1)
    axis = quat_to_matrix(quats).gather(2, thin[:, None, None].expand(-1, 3, 1))[:, :, 0]
    target = torch.where((axis * n).sum(-1, keepdim=True) < 0, -n, n)
    splats["quats"][idx] = quat_multiply(rotation_between(axis, target), F.normalize(quats, dim=-1))
    scales.scatter_(1, thin[:, None], scales.gather(1, thin[:, None]).clamp(max=math.log(thickness)))
    splats["scales"][idx] = scales
    return len(idx)


@torch.no_grad()
def limit_anisotropy(log_scales: torch.Tensor, ratio: float) -> None:
    """Splats no longer than `ratio` times their middle axis. A needle looks right from the photos'
    spots and like a streak from anywhere else; it takes a few rounder splats instead."""
    values, order = log_scales.sort(dim=1)
    cap = values[:, 1:2] + math.log(ratio)
    longest = F.one_hot(order[:, 2], 3).bool()
    log_scales.copy_(torch.where(longest & (log_scales > cap), cap.expand_as(log_scales), log_scales))


@torch.no_grad()
def clear_floaters(splats, centers: torch.Tensor, surfaces: SurfaceIndex, radius: float) -> int:
    """Splats hanging in the air right in front of where a photo was taken (within `radius` m of a
    camera, away from every surface a photo saw): what a photo explains with something close to the
    lens instead of the room behind. Made transparent, so training drops or reuses them."""
    means = splats["means"]
    close = torch.zeros(len(means), dtype=torch.bool, device=means.device)
    step = max(1024, (1 << 26) // max(1, len(centers)))
    for start in range(0, len(means), step):
        chunk = means[start : start + step]
        close[start : start + step] = torch.cdist(chunk, centers).min(dim=1).values < radius
    floaters = close & ~surfaces.near(means)
    count = int(floaters.sum())
    if count:
        splats["opacities"][floaters] = -10.0
    return count
