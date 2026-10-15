"""Better lighting (light.py): one per-pixel adjustment from the walls, the same for skins and spots."""

import numpy as np

from atrium_remaster import light
from atrium_remaster.scene import Mesh


def box_room(wall: tuple, floor: tuple, accent: tuple | None = None, size: int = 64) -> Mesh:
    """Four walls, a floor and a ceiling, each a flat square chart in its own quarter-row of one atlas.
    `accent`: the first wall's color instead (a feature wall)."""
    s = 3.0
    quads = [
        ([0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0]),  # walls
        ([0, 0, s], [s, 0, s], [s, s, s], [0, s, s]),
        ([0, 0, 0], [0, 0, s], [0, s, s], [0, s, 0]),
        ([s, 0, 0], [s, 0, s], [s, s, s], [s, s, 0]),
        ([0, 0, 0], [s, 0, 0], [s, 0, s], [0, 0, s]),  # floor
        ([0, s, 0], [s, s, 0], [s, s, s], [0, s, s]),  # ceiling
    ]
    colors = [accent or wall, wall, wall, wall, floor, wall]
    n = len(quads)
    atlas = np.zeros((size, size * n, 3), np.float32)
    vertices, uvs, faces = [], [], []
    for k, (quad, color) in enumerate(zip(quads, colors)):
        atlas[:, k * size : (k + 1) * size] = color
        base = len(vertices)
        vertices += quad
        u0, u1 = (k * size + 1) / (size * n), ((k + 1) * size - 1) / (size * n)
        uvs += [[u0, 0.02], [u1, 0.02], [u1, 0.98], [u0, 0.98]]
        faces += [[base, base + 1, base + 2], [base, base + 2, base + 3]]
    return Mesh(
        vertices=np.array(vertices, np.float32),
        uvs=np.array(uvs, np.float32),
        faces=np.array(faces, np.int64),
        face_atlas=np.zeros(len(faces), np.int64),
        face_color=np.zeros((len(faces), 3), np.float32),
        atlases=[atlas],
    )


def wall_color(mesh: Mesh) -> np.ndarray:
    return mesh.atlases[0][32, 64 + 32]


def test_a_warm_dim_room_comes_out_neutral_and_bright():
    room = box_room(wall=(0.58, 0.52, 0.44), floor=(0.40, 0.28, 0.18))
    lit, stats = light.measure(room)
    out = light.apply(room, lit)
    before, after = wall_color(room), wall_color(out)
    assert after.max() - after.min() < 0.04 < before.max() - before.min(), "the bulbs' warmth is taken out of the walls"
    assert after.mean() > before.mean() + 0.15 and 0.7 < after.mean() <= 0.82, "the walls come up toward daylight (brightening is capped)"
    floor = out.atlases[0][32, 4 * 64 + 32]
    assert floor[0] > floor[1] > floor[2], "a wood floor stays wood-colored"
    assert stats["lightExposure"] > 1 and len(stats["lightGains"]) == 3


def test_a_feature_wall_doesnt_set_the_white_balance():
    plain = light.measure(box_room(wall=(0.7, 0.7, 0.7), floor=(0.4, 0.3, 0.2)))[0]
    accent = light.measure(box_room(wall=(0.7, 0.7, 0.7), floor=(0.4, 0.3, 0.2), accent=(0.1, 0.35, 0.6)))[0]
    assert np.allclose(plain.gains / plain.gains.mean(), accent.gains / accent.gains.mean(), atol=0.02)


def test_highlights_roll_off_instead_of_clipping_and_order_is_kept():
    lit = light.Light(gains=np.full(3, 1.8, np.float32), lift=0.12, shoulder=0.8)
    ramp = np.linspace(0, 1, 256, dtype=np.float32)[:, None].repeat(3, axis=1)
    out = lit(ramp)[:, 0]
    assert (np.diff(out) >= -1e-6).all(), "brighter stays brighter"
    assert out.max() <= 1 and (out[200:] < 0.999).sum() > 20, "highlights keep detail below white"
    window = lit(np.array([[1.0, 0.95, 0.85]], np.float32))[0]
    assert window.max() <= 1 and window[0] >= window[2], "a bright warm window keeps its hue, not a clipped channel"


def test_a_blown_out_window_stays_white_and_untinted():
    """Clipped glass is the camera's white, not the room's light: whatever the walls' correction does,
    it stays white, not a shade of grey or pink (a real home's windows came out a pinkish grey), and
    the curve has no step where the highlights start rolling off."""
    ramp = np.linspace(0, 1, 256, dtype=np.float32)[:, None].repeat(3, axis=1)
    for gains in ([1.0, 1.0, 1.0], [1.1, 1.0, 1.1], [1.2, 1.1, 1.25], [0.9, 0.9, 0.9], [1.8, 1.8, 1.8]):
        lit = light.Light(gains=np.array(gains, np.float32), lift=0.12, shoulder=0.8)
        white = lit(np.ones((1, 3), np.float32))[0]
        assert white.min() > 0.995, (gains, white)
        near = lit(np.full((1, 3), 0.98, np.float32))[0]
        assert near.max() - near.min() < 0.01, (gains, near)
        out = lit(ramp)
        steps = np.diff(out, axis=0)
        assert (np.diff(out @ light.LUMA) >= -1e-6).all() and steps.min() > -0.5 / 255 and steps.max() < 0.03, (gains, steps.min(), steps.max())
    # Away from white the walls' tint still comes out.
    grey = light.Light(gains=np.array([1.1, 1.0, 1.1], np.float32), lift=0.12, shoulder=0.8)(np.full((1, 3), 0.5, np.float32))[0]
    assert grey[0] > grey[1] + 0.01 and grey[2] > grey[1] + 0.01


def test_no_walls_no_change():
    floor_only = box_room(wall=(0.5, 0.5, 0.5), floor=(0.4, 0.3, 0.2))
    floor_only = Mesh(
        vertices=floor_only.vertices,
        uvs=floor_only.uvs,
        faces=floor_only.faces[8:10],
        face_atlas=floor_only.face_atlas[8:10],
        face_color=floor_only.face_color[8:10],
        atlases=floor_only.atlases,
    )
    lit, stats = light.measure(floor_only)
    assert lit.identity and "lightSkipped" in stats and light.apply(floor_only, lit) is floor_only
