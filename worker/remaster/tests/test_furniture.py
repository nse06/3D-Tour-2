"""AI-made furniture (furniture.py): a shape from the shape maker turned and stretched into the box
the scan measured, so its outline matches the photos' cutouts, in place of the scanned piece."""

import math

import numpy as np
from scipy.spatial import cKDTree

from atrium_photoreal.capture import load
from atrium_photoreal.enhance import heading, look
from atrium_remaster import edit, furniture, glb, layout, scene, views
from atrium_remaster.job import Services, remaster

from . import room


def chair() -> tuple[np.ndarray, np.ndarray]:
    """A chair with one armrest, in a frame of its own: x across, y up, its back toward -z."""
    parts = [
        ((0.0, 0.42, 0.0), (0.5, 0.06, 0.5)),  # the seat
        ((0.0, 0.70, -0.22), (0.5, 0.5, 0.06)),  # the back
        ((0.22, 0.58, 0.02), (0.06, 0.26, 0.42)),  # one armrest, on its right
    ] + [((sx * 0.21, 0.2, sz * 0.21), (0.05, 0.4, 0.05)) for sx in (-1, 1) for sz in (-1, 1)]  # the legs
    vs, fs = [], []
    for center, size in parts:
        v, f = edit.box(np.array(center), np.eye(3), np.array(size))
        fs.append(f + sum(len(x) for x in vs))
        vs.append(v)
    return np.concatenate(vs).astype(np.float64), np.concatenate(fs)


def aim(position: np.ndarray, target: np.ndarray) -> np.ndarray:
    d = target - position
    forward = np.eye(4)
    forward[:3, 2] = d / np.linalg.norm(d)
    return look(position, *heading(forward))


def test_a_shape_is_turned_and_stretched_to_match_the_cutouts():
    v, f = chair()
    turn = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])  # a quarter turn: its back toward -x
    size = np.ptp(v @ turn.T, axis=0)
    box = layout.Box("C", "chair", np.array([1.5, size[1] / 2, 1.6]), np.eye(3), size)
    truth = furniture.placed(v, turn, box)
    # The shape maker's frame: facing the other way, half the size, somewhere else.
    half_turn = np.diag([-1.0, 1.0, -1.0])
    made = v @ half_turn.T * 0.5 + np.array([3.0, -2.0, 1.0])
    # The cutouts: the chair's outline from four spots around it (the room's walls and floor behind).
    items = room.charts()
    room.pack(items)
    walls = room.build_mesh(items, room.truth_atlas(items))
    walls_caster, chair_caster = views.Caster.of(walls), views.Caster(truth, f)
    K = np.array([[room.F, 0, room.W / 2], [0, room.F, room.H / 2], [0, 0, 1]])
    fit_views = []
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        pose = aim(np.array([1.5 + 1.1 * math.sin(a), 1.3, 1.6 + 1.1 * math.cos(a)]), box.center)
        mask = chair_caster.view(K, pose, room.W, room.H).hit
        fit_views.append(furniture.FitView(K, pose, room.W, room.H, mask, walls_caster.view(K, pose, room.W, room.H).depth))
    world, faces, iou = furniture.fit(made, f, box, fit_views)
    assert iou > 0.97
    gap, _ = cKDTree(truth).query(world)
    assert gap.max() < 1e-6, "every corner where the chair is"
    a, b, c = (world[faces[:, k]] for k in range(3))
    assert np.einsum("ij,ij->i", a, np.cross(b, c)).sum() > 0, "wound outward"
    # A maker with z up: found too when any way up is allowed.
    z_up = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
    world, faces, iou = furniture.fit(v @ z_up.T, f, box, fit_views, upright=False)
    assert iou > 0.97 and cKDTree(truth).query(world)[0].max() < 1e-6


class BoxMaker:
    """Stand-in shape maker: a box of other proportions, whatever the picture."""

    name = "box"

    def __init__(self):
        self.images = []

    def __call__(self, images):
        self.images += images
        return [edit.box(np.zeros(3), np.eye(3), np.array([1.0, 1.1, 0.6])) for _ in images]


def scanned_short(mesh, top: float):
    """The model with its scanned cabinet cut off at `top` (the LiDAR missed the rest)."""
    cabinet = np.repeat(np.arange(len(room.charts())), 2) >= 6
    v = mesh.vertices.copy()
    ids = np.unique(mesh.faces[cabinet])
    v[ids, 1] = np.minimum(v[ids, 1], top)
    return scene.Mesh(v, mesh.uvs, mesh.faces, mesh.face_atlas, mesh.face_color, mesh.atlases, mesh.extras)


def test_a_scanned_piece_is_replaced_by_the_shape_made_for_it(tmp_path):
    room.write(tmp_path, layout=room.layout_doc(cabinet="table"))
    # The LiDAR caught the cabinet only up to 50 cm: the photos show all 90.
    mesh = scanned_short(scene.from_model(glb.read((tmp_path / "model.glb").read_bytes())), 0.5)
    capture = load(tmp_path / "capture")
    lay = layout.load(tmp_path / "capture")
    maker = BoxMaker()
    cfg = furniture.FurnitureConfig(long_side=160, in_frame=0.8, crop=64, fit_px=80)  # few photos see the low cabinet whole
    out, stats = furniture.run(mesh, capture, lay, furniture.BoxSegmenter(), maker, cfg, log=lambda _: None)
    assert stats["furnitureMade"] == 1 and stats["furnitureFit"]["CAB"] > 0.8 and stats["furnitureScannedFit"]["CAB"] < 0.7, stats
    assert len(maker.images) == 1 and maker.images[0].shape == (64, 64, 3), "the clearest cutout went to the maker"
    corners = np.array([[1.0, 0.0, 0.0], [1.8, 0.9, 0.5]])
    cabinet = np.repeat(np.arange(len(room.charts())), 2) >= 6
    kept = len(mesh.faces) - int(cabinet.sum())
    assert len(out.faces) == kept + 12 and np.allclose(out.faces[:kept], mesh.faces[~cabinet]), "the scanned cabinet's faces went"
    new = out.vertices[np.unique(out.faces[kept:])]
    assert np.allclose(new.min(0), corners[0], atol=1e-5) and np.allclose(new.max(0), corners[1], atol=1e-5), "the shape fills the box"
    assert len(out.atlases) == len(mesh.atlases) + 1 and (out.face_atlas[kept:] == len(mesh.atlases)).all(), "with texels of its own"


def test_box_shaped_furniture_the_reviewer_flags_becomes_roomplans_box(tmp_path):
    """A dresser (RoomPlan's "storage", which the shape maker never makes) the reviewer says is a box
    with holes or warped sides: it comes back as the box RoomPlan measured, without asking the shape
    maker, and the photos paint it. Unflagged, storage stays as scanned."""
    room.write(tmp_path, layout=room.layout_doc())
    mesh = scanned_short(scene.from_model(glb.read((tmp_path / "model.glb").read_bytes())), 0.5)
    capture = load(tmp_path / "capture")
    lay = layout.load(tmp_path / "capture")

    def maker(images):
        raise AssertionError("a box needs no shape maker")

    cfg = furniture.FurnitureConfig(long_side=160, in_frame=0.8, crop=64, fit_px=80)
    same, stats = furniture.run(mesh, capture, lay, furniture.BoxSegmenter(), maker, cfg, log=lambda _: None)
    assert same is mesh and stats["furnitureMade"] == 0, "storage isn't made unless the reviewer asks"
    out, stats = furniture.run(mesh, capture, lay, furniture.BoxSegmenter(), maker, cfg, log=lambda _: None, also={"CAB": "box"})
    assert stats["furnitureMade"] == 1 and stats["furnitureFit"]["CAB"] > stats["furnitureScannedFit"]["CAB"] + 0.05, stats
    cabinet = np.repeat(np.arange(len(room.charts())), 2) >= 6
    kept = len(mesh.faces) - int(cabinet.sum())
    new = out.vertices[np.unique(out.faces[kept:])]
    assert len(out.faces) == kept + 12 and np.allclose(new.min(0), [1.0, 0.0, 0.0], atol=1e-5) and np.allclose(new.max(0), [1.8, 0.9, 0.5], atol=1e-5)


def test_the_reviewers_picks_replace_the_scan_without_beating_its_outline(tmp_path):
    """The reviewer saw the scanned piece is broken (holes hardly change an outline): its pick replaces
    the scan though it matches the photos no better, and with `only_also` nothing else is made."""
    room.write(tmp_path, layout=room.layout_doc(cabinet="table"))
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")
    lay = layout.load(tmp_path / "capture")
    cfg = furniture.FurnitureConfig(long_side=160, in_frame=0.8, crop=64, fit_px=80)
    for pick in ("made", "box"):
        out, stats = furniture.run(mesh, capture, lay, furniture.BoxSegmenter(), BoxMaker(), cfg, log=lambda _: None, also={"CAB": pick})
        assert stats["furnitureMade"] == 1 and stats["furnitureFit"]["CAB"] < stats["furnitureScannedFit"]["CAB"] + 0.05, (pick, stats)
    maker = BoxMaker()
    out, stats = furniture.run(mesh, capture, lay, furniture.BoxSegmenter(), maker, cfg, log=lambda _: None, also={}, only_also=True)
    assert out is mesh and stats["furnitureMade"] == 0 and not maker.images, "the reviewer picked nothing: nothing made"


def test_a_picked_dresser_no_photo_frames_is_still_roomplans_box(tmp_path, monkeypatch):
    """A long dresser against a wall may be in no photo half framed (a real 1.8 m one wasn't): picked
    by the reviewer, RoomPlan's storage box goes in unchecked, starting as the scan's color. A table
    so picked isn't (RoomPlan's tables are less often their box)."""
    monkeypatch.setattr(furniture, "sights", lambda *a, **k: [])

    def maker(images):
        raise AssertionError("a box needs no shape maker")

    cfg = furniture.FurnitureConfig(long_side=160, in_frame=0.8, crop=64, fit_px=80)
    for category, made in (("storage", 1), ("table", 0)):
        room.write(tmp_path / category, layout=room.layout_doc(cabinet=category))
        mesh = scanned_short(scene.from_model(glb.read((tmp_path / category / "model.glb").read_bytes())), 0.5)
        capture, lay = load(tmp_path / category / "capture"), layout.load(tmp_path / category / "capture")
        out, stats = furniture.run(mesh, capture, lay, furniture.BoxSegmenter(), maker, cfg, log=lambda _: None, also={"CAB": "box"}, only_also=True)
        assert stats["furnitureMade"] == made and stats.get("furnitureUnchecked", 0) == made, (category, stats)
    cabinet = np.repeat(np.arange(len(room.charts())), 2) >= 6
    kept = len(mesh.faces) - int(cabinet.sum())
    room.write(tmp_path / "again", layout=room.layout_doc())
    mesh = scanned_short(scene.from_model(glb.read((tmp_path / "again" / "model.glb").read_bytes())), 0.5)
    out, _ = furniture.run(mesh, load(tmp_path / "again" / "capture"), layout.load(tmp_path / "again" / "capture"), furniture.BoxSegmenter(), maker, cfg, log=lambda _: None, also={"CAB": "box"}, only_also=True)
    new = out.vertices[np.unique(out.faces[kept:])]
    assert len(out.faces) == kept + 12 and np.allclose(new.min(0), [1.0, 0.0, 0.0], atol=1e-5) and np.allclose(new.max(0), [1.8, 0.9, 0.5], atol=1e-5)


def test_a_box_much_worse_than_the_scan_isnt_used(tmp_path):
    """RoomPlan's box for a sofa takes in its back cushions. Here the box is twice the cabinet's height
    and the photos show the cabinet (the lower half): the box matches them far worse than the scan,
    so the reviewer's box pick isn't used."""
    doc = room.layout_doc()
    cab = next(o for o in doc["objects"] if o["id"] == "CAB")
    cab["center"], cab["size"] = [1.4, 0.9, 0.25], [0.8, 1.8, 0.5]
    room.write(tmp_path, layout=doc)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))

    class LowerHalf(furniture.BoxSegmenter):
        def __call__(self, image, boxes):
            masks = super().__call__(image, boxes)
            for mask, (_, y0, _, y1) in zip(masks, boxes):
                mask[: int((y0 + y1) / 2)] = False
            return masks

    cfg = furniture.FurnitureConfig(long_side=160, in_frame=0.8, crop=64, fit_px=80)
    out, stats = furniture.run(mesh, load(tmp_path / "capture"), layout.load(tmp_path / "capture"), LowerHalf(), BoxMaker(), cfg, log=lambda _: None, also={"CAB": "box"}, only_also=True)
    assert out is mesh and stats["furnitureMade"] == 0, stats
    assert stats["furnitureFit"]["CAB"] < stats["furnitureScannedFit"]["CAB"] - cfg.box_slack, stats


def test_a_shape_no_better_than_the_scan_leaves_the_scan(tmp_path):
    """A piece the LiDAR caught whole (the cabinet as it is) keeps its scanned shape: the made one
    matches the photos no better (a real armchair came out warped and lost its photo look)."""
    room.write(tmp_path, layout=room.layout_doc(cabinet="table"))
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")
    cfg = furniture.FurnitureConfig(long_side=160, in_frame=0.8, crop=64, fit_px=80)
    out, stats = furniture.run(mesh, capture, layout.load(tmp_path / "capture"), furniture.BoxSegmenter(), BoxMaker(), cfg, log=lambda _: None)
    assert out is mesh and stats["furnitureMade"] == 0 and stats["furnitureKept"] == 1, stats
    assert stats["furnitureScannedFit"]["CAB"] > 0.8 and stats["furnitureFit"]["CAB"] < stats["furnitureScannedFit"]["CAB"] + 0.05, stats


def test_pieces_no_photo_shows_and_shapes_that_dont_match_are_left_alone(tmp_path):
    doc = room.layout_doc(cabinet="table")
    doc["objects"].append({"id": "GONE", "category": "sofa", "center": [9.0, 0.4, 9.0], "axes": [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "size": [2.0, 0.8, 0.9]})
    room.write(tmp_path, layout=doc)
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    capture = load(tmp_path / "capture")

    class Pedestal:
        """A round table on one leg, as a shape maker might mistake a cabinet for: even stretched to
        fill the cabinet's box, its outline is a thin top over a thin leg."""

        name = "pedestal"

        def __call__(self, images):
            top, top_f = edit.box(np.array([0.0, 0.97, 0.0]), np.eye(3), np.array([1.0, 0.06, 1.0]))
            leg, leg_f = edit.box(np.array([0.0, 0.47, 0.0]), np.eye(3), np.array([0.08, 0.94, 0.08]))
            return [(np.concatenate([top, leg]), np.concatenate([top_f, leg_f + len(top)])) for _ in images]

    cfg = furniture.FurnitureConfig(long_side=160, in_frame=0.8, crop=64, fit_px=80)  # few photos see the low cabinet whole
    out, stats = furniture.run(mesh, capture, layout.load(tmp_path / "capture"), furniture.BoxSegmenter(), Pedestal(), cfg, log=lambda _: None)
    assert out is mesh and stats["furnitureMade"] == 0 and stats["furnitureKept"] == 2, stats


def test_the_job_makes_furniture_before_the_skins(tmp_path):
    room.write(tmp_path, layout=room.layout_doc(cabinet="table"))
    mesh = scanned_short(scene.from_model(glb.read((tmp_path / "model.glb").read_bytes())), 0.5)
    capture = load(tmp_path / "capture")
    services = Services(segmenter=furniture.BoxSegmenter(), shapes=BoxMaker())
    options = {"steps": 20, "batch": 2, "tile": 128, "longSide": 160, "furnitureLongSide": 160, "furnitureInFrame": 0.8, "fill": False, "trim": False, "fixerViews": False, "depth": False}
    reports = []
    out, stats = remaster(mesh, capture, options, services, "cpu", lambda stage, value, message: reports.append((stage, value)), log=lambda _: None, layout=layout.load(tmp_path / "capture"))
    stages = [stage for stage, _ in reports]
    assert stats["furnitureMade"] == 1 and "furniture" in stages and stages.index("furniture") < stages.index("skins"), (stats, stages)
    made = [value for stage, value in reports if stage == "furniture"]
    assert made == sorted(made) and made[-1] >= 0.85, "how far along it is, piece by piece"
    assert len(out.atlases) == len(mesh.atlases) + 1


def test_once_the_reviewer_has_looked_only_its_picks_are_made(tmp_path):
    """The reviewer found nothing to make again: the furniture stage (minutes of GPU) doesn't run,
    unless `furnitureAll` asks for every piece as before."""
    room.write(tmp_path, layout=room.layout_doc(cabinet="table"))
    mesh = scanned_short(scene.from_model(glb.read((tmp_path / "model.glb").read_bytes())), 0.5)
    capture = load(tmp_path / "capture")
    options = {"steps": 4, "batch": 2, "tile": 128, "longSide": 160, "furnitureLongSide": 160, "furnitureInFrame": 0.8, "fill": False, "trim": False, "fixerViews": False, "depth": False, "loose": False}
    for every, made in ((False, 0), (True, 1)):
        maker = BoxMaker()
        services = Services(segmenter=furniture.BoxSegmenter(), shapes=maker, reviewer=lambda photo, rendered: [])
        _, stats = remaster(mesh, capture, {**options, "furnitureAll": every}, services, "cpu", lambda *a: None, log=lambda _: None, layout=layout.load(tmp_path / "capture"))
        assert stats["reviewIssues"] == 0 and stats.get("furnitureMade", 0) == made and len(maker.images) == made, (every, stats)


def test_what_hides_a_piece_is_painted_over_before_the_maker_sees_it(tmp_path):
    """A box in front of the cabinet (a coffee table before a sofa): in the cutout the maker gets, the
    part it hides is painted in (here a stand-in paints it magenta) and counts as the piece's."""
    room.write(tmp_path, layout=room.layout_doc(cabinet="table"))
    mesh = scene.from_model(glb.read((tmp_path / "model.glb").read_bytes()))
    corners, faces = edit.box(np.array([1.3, 0.3, 0.75]), np.eye(3), np.array([0.4, 0.6, 0.2]))
    mesh, _ = edit.apply(mesh, np.zeros(len(mesh.faces), bool), [edit.Addition(corners, faces, color=(0.1, 0.6, 0.1), name="stool")])
    capture = load(tmp_path / "capture")
    lay = layout.load(tmp_path / "capture")
    cfg = furniture.FurnitureConfig(long_side=160, in_frame=0.8, crop=64, fit_px=80)

    class Magenta:
        name = "magenta"

        def __call__(self, images, masks):
            return [np.where(m[..., None], np.array([255, 0, 255], np.uint8), im) for im, m in zip(images, masks)]

    # What hides it: in the cutout's photo, the stool covers part of the cabinet's outline.
    caster = views.Caster.of(mesh)
    chart = mesh.charts()
    from atrium_remaster.fill import flat_charts

    piece = furniture.piece_faces(mesh, lay.objects[0], chart, set(flat_charts(mesh, chart, 10.0)), cfg.margin)
    assert piece.sum() == 8, "the stool isn't the cabinet"
    s = furniture.sights(caster, piece, lay.objects[0], capture.cameras, cfg)[0]
    outline, hides = furniture.hidden(caster, np.flatnonzero(piece), views.Caster(mesh.vertices, mesh.faces[piece]), s)
    assert 0.05 < hides.sum() / outline.sum() < 0.6
    painted, plain = BoxMaker(), BoxMaker()
    furniture.run(mesh, capture, lay, furniture.BoxSegmenter(), painted, cfg, log=lambda _: None, inpainter=Magenta())
    furniture.run(mesh, capture, lay, furniture.BoxSegmenter(), plain, cfg, log=lambda _: None)
    magenta = lambda im: ((im[..., 0] > 200) & (im[..., 1] < 60) & (im[..., 2] > 200)).sum()  # noqa: E731
    assert magenta(painted.images[0]) > 20 and magenta(plain.images[0]) == 0
