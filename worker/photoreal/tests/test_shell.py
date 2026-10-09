"""The rooms' shell (shell.py): planes found from the rooms and checked against the seeds, splats
snapped flat onto them, the anisotropy limit, floaters in front of the cameras, and the photo spots
the viewer gets.  Run: cd worker/photoreal && python -m pytest tests -q"""

import math

import numpy as np
import torch

from atrium_photoreal import shell
from atrium_photoreal.capture import Camera
from atrium_photoreal.job import photo_spots

from . import scene

# A 4 m x 3 m room, 2.5 m high. The wall at x = 4 isn't there (the outline edge opens onto another
# room), and the wall at z = 0 has a doorway from x = 1 to 1.9, up to 2.0 m.
ROOM = {"name": "Room", "floorY": 0.0, "ceilingY": 2.5, "polygon": [[0, 0], [4, 0], [4, 3], [0, 3]]}
DOOR = (1.0, 1.9, 2.0)


def room_seeds(spacing=0.05):
    pts, normals = [], []

    def grid(u0, u1, v0, v1):
        u, v = np.meshgrid(np.arange(u0, u1, spacing) + spacing / 2, np.arange(v0, v1, spacing) + spacing / 2)
        return u.ravel(), v.ravel()

    x, z = grid(0, 4, 0, 3)
    pts += [np.stack([x, np.zeros_like(x), z], 1), np.stack([x, np.full_like(x, 2.5), z], 1)]
    normals += [np.tile([0, 1, 0], (len(x), 1)), np.tile([0, -1, 0], (len(x), 1))]
    x, y = grid(0, 4, 0, 2.5)
    door = (x > DOOR[0]) & (x < DOOR[1]) & (y < DOOR[2])
    pts += [np.stack([x[~door], y[~door], np.zeros((~door).sum())], 1), np.stack([x, y, np.full_like(x, 3.0)], 1)]
    normals += [np.tile([0, 0, 1], ((~door).sum(), 1)), np.tile([0, 0, -1], (len(x), 1))]
    z, y = grid(0, 3, 0, 2.5)
    pts.append(np.stack([np.zeros_like(z), y, z], 1))
    normals.append(np.tile([1, 0, 0], (len(z), 1)))
    return np.concatenate(pts).astype(np.float32), np.concatenate(normals).astype(np.float32)


def room_shell():
    xyz, normal = room_seeds()
    found = shell.from_capture([ROOM], xyz, normal, spacing=0.05)
    assert found is not None
    return found


def splats_at(points, scales, quats=None):
    n = len(points)
    return {
        "means": torch.tensor(points, dtype=torch.float32),
        "scales": torch.log(torch.tensor(scales, dtype=torch.float32)),
        "quats": torch.tensor(quats if quats is not None else [[1, 0, 0, 0]] * n, dtype=torch.float32),
        "opacities": torch.zeros(n),
    }


def test_the_shell_is_where_the_seeds_say():
    s = room_shell()
    assert (s.walls, s.flats) == (3, 2), s.names
    planes = [(tuple(float(v) for v in np.round(n, 3)), round(o, 3)) for n, o in zip(s.normal.tolist(), s.offset.tolist())]
    # Normals point into the room: the wall at z = 0 faces +z, the one at x = 0 faces +x, and so on.
    assert sorted(planes) == sorted(
        [((0, 0, 1), 0.0), ((0, 0, -1), -3.0), ((1, 0, 0), 0.0), ((0, 1, 0), 0.0), ((0, -1, 0), -2.5)]
    ), planes


def test_a_plane_sits_on_its_seeds_even_off_the_outline():
    """RoomPlan's outline and the painted walls can disagree by a few centimeters: the seeds win."""
    xyz, normal = room_seeds()
    xyz[np.isclose(xyz[:, 0], 0) & (normal[:, 0] > 0.5), 0] = 0.04  # the x = 0 wall is really at x = 4 cm
    s = shell.from_capture([ROOM], xyz, normal, spacing=0.05)
    k = next(i for i, n in enumerate(s.normal.tolist()) if n[0] > 0.5)
    assert abs(s.offset[k].item() - 0.04) < 1e-4


def test_splats_on_a_wall_lie_flat_on_it_and_nothing_else_moves():
    s = room_shell()
    rng = np.random.default_rng(3)
    q = rng.normal(size=(8, 4))
    points = [
        [2.5, 1.2, 0.02],  # 2 cm in front of the z = 0 wall: snapped
        [0.015, 1.0, 1.5],  # 1.5 cm off the x = 0 wall: snapped
        [2.0, 0.01, 1.5],  # on the floor: snapped
        [1.45, 1.0, 0.01],  # in the doorway: no wall there
        [3.99, 1.0, 1.5],  # at the open edge (x = 4): no wall there
        [2.0, 1.2, 0.10],  # 10 cm in front of the wall: not on it
        [2.0, 1.2, 1.5],  # the middle of the room
        [2.5, 1.2, -0.01],  # just behind the z = 0 wall: snapped onto it
    ]
    scales = [[0.05, 0.004, 0.01]] * 8
    splats = splats_at(points, scales, q)
    before = {k: v.clone() for k, v in splats.items()}
    assert shell.snap_to_shell(splats, s, within=0.025, thickness=0.002) == 4
    snapped = [0, 1, 2, 7]
    normals = torch.tensor([[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=torch.float32)
    on_plane = [splats["means"][0, 2], splats["means"][1, 0], splats["means"][2, 1], splats["means"][7, 2]]
    assert all(abs(float(v)) < 1e-6 for v in on_plane)
    # The splat's covariance: the plane's normal is an axis, and the splat is at most 2 mm thick along it.
    R = shell.quat_to_matrix(splats["quats"][snapped])
    S = torch.exp(splats["scales"][snapped])
    cov = R @ torch.diag_embed(S**2) @ R.transpose(1, 2)
    along = torch.einsum("ni,nij,nj->n", normals, cov, normals)
    assert (along <= 0.002**2 + 1e-9).all(), along
    assert torch.allclose(cov @ normals[..., None], along[:, None, None] * normals[..., None], atol=1e-7)
    # The splat keeps its size in the plane: the 5 cm and 1 cm axes stay (one may now lie flat).
    assert torch.allclose(S.sort(dim=1).values[:, 1:], torch.tensor([0.01, 0.05]).expand(4, 2), atol=1e-6)
    untouched = [3, 4, 5, 6]
    for k in ("means", "scales", "quats"):
        assert torch.equal(splats[k][untouched], before[k][untouched]), k


def test_nearest_plane_is_the_same_in_chunks():
    s = room_shell()
    points = torch.from_numpy(np.random.default_rng(1).uniform([-0.5, -0.2, -0.5], [4.5, 2.7, 3.5], (5000, 3)).astype(np.float32))
    d1, k1 = shell.nearest_plane(s, points)
    d2, k2 = shell.nearest_plane(s, points, chunk=777)
    assert torch.equal(k1, k2) and torch.equal(torch.isinf(d1), torch.isinf(d2))
    assert torch.allclose(d1[k1 >= 0], d2[k2 >= 0])
    # Over the floor and between the walls, a point is never farther than half the room from a plane.
    inside = (points[:, 0] > 0) & (points[:, 0] < 4) & (points[:, 2] > 0) & (points[:, 2] < 3) & (points[:, 1] > 0) & (points[:, 1] < 2.5)
    assert (k1[inside] >= 0).all() and (d1[inside] <= 1.5 + 1e-5).all()


def test_no_splat_is_a_needle():
    rng = np.random.default_rng(0)
    log_scales = torch.from_numpy(rng.uniform(-7, -1, (2000, 3)).astype(np.float32))
    before = log_scales.clone()
    shell.limit_anisotropy(log_scales, 6.0)
    values = log_scales.sort(dim=1).values
    assert (values[:, 2] - values[:, 1] <= math.log(6.0) + 1e-5).all()
    # Only the longest axis ever shrinks, and only splats that were too long change at all.
    assert (log_scales <= before).all()
    ok = (before.sort(dim=1).values[:, 2] - before.sort(dim=1).values[:, 1]) <= math.log(6.0)
    assert torch.equal(log_scales[ok], before[ok])
    assert torch.equal(log_scales.sort(dim=1).values[:, :2], before.sort(dim=1).values[:, :2])


def test_floaters_in_front_of_a_camera_are_cleared():
    seeds = torch.tensor([[0.0, 0.0, 0.0], [1.0, 1.4, 0.2]])
    surfaces = shell.SurfaceIndex(seeds, 0.1)
    centers = torch.tensor([[1.0, 1.4, 0.0]])
    splats = {
        "means": torch.tensor([[1.0, 1.4, -0.2], [1.0, 1.42, 0.2], [3.0, 1.4, 0.0], [0.02, 0.0, 0.01]]),
        "opacities": torch.zeros(4),
    }
    assert shell.clear_floaters(splats, centers, surfaces, radius=0.3) == 1
    assert splats["opacities"].tolist() == [-10.0, 0.0, 0.0, 0.0]


def test_surface_index_groups_and_neighbours():
    pts = torch.tensor([[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]])
    index = shell.SurfaceIndex(pts, 0.05, groups=torch.tensor([0, 7]))
    near = index.near(torch.tensor([[0.06, 0.0, 0.0], [0.2, 0.0, 0.0], [1.0, 1.0, 1.04], [1.0, 1.0, 1.0]]), torch.tensor([0, 0, 7, 0]))
    assert near.tolist() == [True, False, True, False]


def test_photo_spots_point_where_the_viewer_expects():
    """The viewer turns [x, y, z, yaw, pitch] into the direction (−sin yaw cos pitch, sin pitch,
    −cos yaw cos pitch): the way the photo looked (ARKit's camera looks along its −z)."""
    cameras = []
    for yaw, pitch in [(0.0, 0.0), (1.0, 0.3), (-2.5, -0.6), (3.0, 0.9)]:
        pose = scene.arkit_pose(np.array([1.0, 1.4, 2.0]), yaw, pitch)
        from atrium_photoreal.capture import ARKIT_TO_OPENCV

        cameras.append(Camera("x", None, None, 4, 3, np.eye(3), pose @ ARKIT_TO_OPENCV))
    spots = photo_spots(type("Capture", (), {"cameras": cameras})())
    for spot, camera in zip(spots, cameras):
        x, y, z, yaw, pitch = spot
        direction = np.array([-math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)])
        looking = camera.camtoworld[:3, 2]
        assert np.allclose(direction, looking, atol=2e-3), (spot, looking)
        assert np.allclose([x, y, z], [1.0, 1.4, 2.0])
