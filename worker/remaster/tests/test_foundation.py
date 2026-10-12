"""The remaster's footing: the model file in and out, and where each pixel of a view lands.
Run: cd worker/remaster && python -m pytest tests -q"""

import math

import numpy as np

from atrium_photoreal.capture import load
from atrium_photoreal.enhance import look
from atrium_remaster import glb, scene, views

from . import room


def test_the_painted_model_comes_back_as_written(tmp_path):
    truth = room.write(tmp_path)
    model = glb.read((tmp_path / "model.glb").read_bytes())
    assert len(model.primitives) == 1 and model.materials[0].unlit and model.images[0].mime == "image/jpeg"
    assert model.extras["atrium"]["schema"] == "atrium.scan-manifest/v1"
    mesh = scene.from_model(model)
    assert np.allclose(mesh.vertices, truth["mesh"].vertices) and np.allclose(mesh.uvs, truth["mesh"].uvs)
    assert (mesh.faces == truth["mesh"].faces).all()
    assert len(np.unique(mesh.charts())) == len(truth["charts"]), "a chart per flat face, found from shared vertices"
    assert np.allclose(mesh.texel_size(), room.TEXEL, rtol=1e-3)
    # Written again: same triangles, same texture (JPEG aside), same extras.
    again = scene.from_model(glb.read(glb.write(scene.to_model(mesh, quality=98))))
    assert np.allclose(again.vertices, mesh.vertices) and (again.faces == mesh.faces).all()
    assert np.abs(again.atlases[0] - mesh.atlases[0]).mean() < 0.01
    assert again.extras == mesh.extras


def test_node_transforms_are_applied_and_flat_materials_kept():
    prim = glb.Primitive(np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32), np.array([[0, 1, 2]]), None, 0, "tri")
    model = glb.Model([prim], [glb.Material("grey", color=(0.2, 0.2, 0.2, 1.0), unlit=False)])
    data = glb.write(model)
    back = glb.read(data)
    assert back.materials[0].image is None and not back.materials[0].unlit
    mesh = scene.from_model(back)
    assert (mesh.face_atlas == -1).all() and np.allclose(mesh.face_color[0], scene.srgb_of_linear(np.float32(0.2)), atol=1e-6)


def test_triangle_normals_and_areas_are_worked_out_once():
    """Trim asks for them chart by chart (thousands of charts in a home): once per mesh, read-only."""
    prim = glb.Primitive(np.array([[0, 0, 0], [2, 0, 0], [0, 1, 0]], np.float32), np.array([[0, 1, 2]]), None, 0, "tri")
    mesh = scene.from_model(glb.Model([prim], [glb.Material("grey", color=(0.2, 0.2, 0.2, 1.0), unlit=False)]))
    assert mesh.face_normals is mesh.face_normals and mesh.face_areas is mesh.face_areas
    assert np.allclose(mesh.face_normals[0], [0, 0, 1]) and np.isclose(mesh.face_areas[0], 1.0)
    assert not mesh.face_normals.flags.writeable and not mesh.face_areas.flags.writeable


def test_rays_find_the_surface_and_where_on_it(tmp_path):
    truth = room.write(tmp_path)
    mesh = truth["mesh"]
    caster = views.Caster.of(mesh)
    # Looking straight at the far wall (z = 0) from 2 m away: depth 2 m in the middle of the view.
    pose = look([1.5, 1.25, 2.0], 0.0, 0.0)
    K = truth["K"]
    hits = caster.view(K, pose, room.W, room.H)
    assert hits.hit.all()
    assert abs(hits.depth[room.H // 2, room.W // 2] - 2.0) < 1e-3
    points = views.surface_points(mesh, hits)
    assert abs(points[room.H // 2, room.W // 2, 2]) < 1e-4
    # The barycentric weights put every pixel's texture coordinate where the truth is.
    render = views.render(mesh, hits)
    exact = room.truth_color(truth["charts"], mesh, hits)
    assert np.abs(render - exact).mean() < 0.08
    swapped = views.Hits(hits.face, hits.bary[..., ::-1].copy(), hits.depth)
    assert np.abs(views.render(mesh, swapped) - exact).mean() > 2 * np.abs(render - exact).mean()


def test_the_photos_line_up_with_the_model(tmp_path):
    truth = room.write(tmp_path, brightness_spread=0.0, noise=0.0, smeared=())
    capture = load(tmp_path / "capture")
    caster = views.Caster.of(truth["mesh"])
    from PIL import Image

    for cam in capture.cameras[:4]:
        hits = caster.view(cam.K, cam.camtoworld, cam.width, cam.height)
        photo = np.asarray(Image.open(cam.image_path), np.float32) / 255
        assert np.abs(photo - room.truth_color(truth["charts"], truth["mesh"], hits)).mean() < 0.003
    assert math.isclose(capture.cameras[0].K[0, 0], room.F)
