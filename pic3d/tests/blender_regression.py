"""Regression tests for Relief's Blender side (inspector, repair, checkpoints, exports, job checks).

    blender -b --factory-startup -noaudio --python-exit-code 1 -P tests/blender_regression.py -- WORKDIR [model.glb ...]

Builds small meshes with one known defect each and checks that the inspector finds it, that repair
fixes it without changing the model's size, that a bad change is rolled back, that every export
format survives being imported again, and that invalid jobs are refused. Any extra .glb paths are
real models: they must come out of repair no worse than they went in, and re-import cleanly.
Exits with code 1 if anything fails.
"""
import math
import os
import shutil
import sys
import time

import bmesh
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "blender"))

import inspector  # noqa: E402
import relief_ops as ops  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
WORK = os.path.realpath(args[0] if args else os.path.join(HERE, "_work"))
REAL = args[1:]
shutil.rmtree(WORK, ignore_errors=True)
os.makedirs(WORK)
results = []


def test(name):
    def wrap(fn):
        t0 = time.time()
        try:
            fn()
            results.append((name, True, ""))
            print(f"PASS {name} ({time.time() - t0:.1f}s)")
        except Exception as e:  # noqa: BLE001
            results.append((name, False, f"{type(e).__name__}: {e}"))
            print(f"FAIL {name}: {type(e).__name__}: {e}")
        return fn
    return wrap


def expect(cond, msg):
    if not cond:
        raise AssertionError(msg)


# --------------------------------------------------------------------------- scene builders

def reset():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)


def mesh_from(build, name="test"):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    return obj


def cube(bm, size=1.0, offset=(0, 0, 0)):
    r = bmesh.ops.create_cube(bm, size=size)
    bmesh.ops.translate(bm, vec=offset, verts=r["verts"])
    return r


def sphere(bm, segs=32, rings=16, radius=0.5, offset=(0, 0, 0)):
    r = bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=radius)
    bmesh.ops.translate(bm, vec=offset, verts=r["verts"])
    return r


def ctx():
    return {"input": None, "workdir": WORK, "report": {}}


def repair(c, **kw):
    params = {k: s["default"] for k, s in ops.OPS["repair"].items()}
    params.update(kw)
    ops.op_repair(c, params)
    return c["report"]["repair"]


def m():
    return inspector.measure()


def same_size(a, b, tol=0.01):
    return ops.dims_change(a, b) <= tol


# --------------------------------------------------------------------------- inspector + repair

@test("clean cube measures as a closed solid")
def _():
    reset()
    mesh_from(cube)
    r = m()
    expect(r["watertight"] and r["boundary_edges"] == 0 and r["holes"] == 0, r)
    expect(r["flipped_edges"] == 0 and r["non_manifold_edges"] == 0, r)
    expect(r["islands"] == 1 and r["specks"] == 0, r)
    expect(abs(r["volume_m3"] - 1.0) < 1e-6 and not r["inside_out"], r)
    expect(r["self_intersecting_triangles"] == 0, r)
    expect(r["triangles"] == 12 and r["degenerate_triangles"] == 0, r)
    p = inspector.profiles(r)
    expect(p["print"]["failed"] == 0, p["print"])


@test("inspector never changes the mesh")
def _():
    reset()
    obj = mesh_from(lambda bm: sphere(bm))
    before = [tuple(v.co) for v in obj.data.vertices]
    inspector.measure()
    inspector.profiles(inspector.measure(deep=False))
    expect(before == [tuple(v.co) for v in obj.data.vertices], "vertex positions changed")


@test("hole is found and filled")
def _():
    reset()
    obj = mesh_from(lambda bm: (cube(bm), bm.faces.ensure_lookup_table(),
                                bmesh.ops.delete(bm, geom=[bm.faces[0]], context="FACES_ONLY")))
    a = m()
    expect(a["boundary_edges"] == 4 and a["holes"] == 1 and not a["watertight"], a)
    c = ctx()
    repair(c)
    b = m()
    expect(b["watertight"] and b["holes"] == 0, b)
    expect(same_size(a, b), "size changed")


@test("one flipped face is found and fixed")
def _():
    reset()
    mesh_from(lambda bm: (cube(bm), bm.faces.ensure_lookup_table(), bmesh.ops.reverse_faces(bm, faces=[bm.faces[0]])))
    a = m()
    expect(a["flipped_edges"] == 4, a)
    expect(inspector.profiles(a)["print"]["failed"] >= 1, "print profile should fail")
    repair(ctx())
    b = m()
    expect(b["flipped_edges"] == 0 and not b["inside_out"], b)


@test("inside-out model is found and turned right way out")
def _():
    reset()
    mesh_from(lambda bm: (cube(bm), bmesh.ops.reverse_faces(bm, faces=bm.faces[:])))
    a = m()
    expect(a["flipped_edges"] == 0 and a["inside_out"] is True and a["volume_m3"] < 0, a)
    repair(ctx())
    b = m()
    expect(b["inside_out"] is False and b["volume_m3"] > 0, b)


@test("seam-split vertices count as duplicates, not as holes")
def _():
    reset()
    mesh_from(lambda bm: (cube(bm), bmesh.ops.split_edges(bm, edges=bm.edges[:])))
    a = m()
    expect(a["duplicate_vertices"] == 24 - 8, a)
    expect(a["boundary_edges"] == 0 and a["watertight"], a)
    repair(ctx())
    b = m()
    expect(b["duplicate_vertices"] == 0 and b["vertices"] == 8, b)


@test("specks are removed, the main shape is kept")
def _():
    reset()

    def build(bm):
        sphere(bm)
        for i in range(5):
            cube(bm, size=0.004, offset=(0.3 + i * 0.01, 0.0, 0.0))
    mesh_from(build)
    a = m()
    expect(a["islands"] == 6 and a["specks"] == 5, a)
    repair(ctx())
    b = m()
    expect(b["islands"] == 1 and b["specks"] == 0, b)
    expect(b["triangles"] >= a["triangles"] - 5 * 12, b)
    expect(same_size(a, b), "size changed")


@test("a long thin part is not mistaken for a speck")
def _():
    reset()

    def build(bm):
        sphere(bm)
        r = bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=0.01, radius2=0.01, depth=1.5)
        bmesh.ops.translate(bm, vec=(1.0, 0, 0), verts=r["verts"])
    mesh_from(build)
    a = m()
    expect(a["islands"] == 2 and a["specks"] == 0, a)
    repair(ctx())
    b = m()
    expect(b["islands"] == 2, f"the bar was deleted: {b['islands']} pieces left")


@test("self-intersecting boxes are detected")
def _():
    reset()
    mesh_from(lambda bm: (cube(bm), cube(bm, offset=(0.5, 0.3, 0.2))))
    a = m()
    expect(a["self_intersecting_triangles"] > 0, a)
    expect(inspector.profiles(a)["print"]["checks"][2]["result"] == "fail", "print should fail on self-intersection")


@test("zero-area face is found and removed")
def _():
    reset()

    def build(bm):
        cube(bm)
        v = [bm.verts.new(p) for p in ((2, 0, 0), (2, 0, 0), (2.5, 0, 0))]
        bm.faces.new(v)
    mesh_from(build)
    a = m()
    expect(a["degenerate_triangles"] >= 1, a)
    repair(ctx())
    b = m()
    expect(b["degenerate_triangles"] == 0, b)


@test("loose edges and points are removed")
def _():
    reset()

    def build(bm):
        cube(bm)
        a, b = bm.verts.new((0.0, 0.0, 0.2)), bm.verts.new((0.0, 0.1, 0.2))
        bm.edges.new((a, b))
        bm.verts.new((0.1, 0.1, 0.1))
    mesh_from(build)
    a = m()
    expect(a["loose_edges"] == 1 and a["loose_vertices"] == 1, a)
    repair(ctx())
    b = m()
    expect(b["loose_edges"] == 0 and b["loose_vertices"] == 0 and b["triangles"] == 12, b)


@test("heavy mesh is reduced to the target and keeps its size")
def _():
    reset()
    mesh_from(lambda bm: sphere(bm, segs=256, rings=128))
    a = m()
    expect(a["triangles"] > 60_000, a)
    steps = repair(ctx(), max_triangles=20_000)
    b = m()
    dec = [s for s in steps if s["step"].startswith("reduce")][0]
    expect(dec["status"] == "ok", dec)
    expect(b["triangles"] <= 20_400, b["triangles"])
    expect(same_size(a, b, 0.02), "size changed")
    expect(b["watertight"], "decimation opened the mesh")


@test("reducing an unwelded mesh keeps its seams closed")
def _():
    reset()

    def build(bm):
        sphere(bm, segs=192, rings=96)
        seam = [e for e in bm.edges if all(abs(v.co.y) < 1e-6 and v.co.x > 0 for v in e.verts)]
        bmesh.ops.split_edges(bm, edges=seam)  # like a UV seam in a glTF file
    mesh_from(build)
    a = m()
    expect(a["duplicate_vertices"] > 0 and a["boundary_edges"] == 0, a)
    steps = repair(ctx(), merge=False, max_triangles=12_000)
    b = m()
    dec = [s for s in steps if s["step"].startswith("reduce")][0]
    expect(dec["status"] == "ok", dec)
    expect(b["triangles"] < a["triangles"] * 0.5, b["triangles"])
    expect(b["boundary_edges"] == 0 and b["islands"] == 1, f"seam cracked: {b['boundary_edges']} open edges, {b['islands']} pieces")


@test("steps with nothing to fix are skipped, not run")
def _():
    reset()
    mesh_from(cube)
    steps = repair(ctx())
    ran = [s["step"] for s in steps if s["status"] not in ("skipped",) and not s["step"].startswith(("reduce", "smooth"))]
    expect(not ran, f"ran on a clean cube: {ran}")


@test("a step that makes things worse is rolled back exactly")
def _():
    reset()
    obj = mesh_from(lambda bm: sphere(bm))
    before = [tuple(v.co) for v in obj.data.vertices]
    c = ctx()

    def bad(o):  # doubles the size: must be refused by the size guard
        for v in o.data.vertices:
            v.co *= 2.0
    entry = ops.guarded(c, "bad step", bad, ops.not_worse())
    expect(entry["status"] == "rolled_back", entry)
    obj = ops.only_mesh()
    expect([tuple(v.co) for v in obj.data.vertices] == before, "mesh wasn't restored")

    def crash(o):
        o.data.vertices[0].co.x += 1
        raise RuntimeError("boom")
    entry = ops.guarded(c, "crashing step", crash, ops.not_worse())
    expect(entry["status"] == "rolled_back" and "boom" in entry["reason"], entry)
    expect([tuple(v.co) for v in ops.only_mesh().data.vertices] == before, "mesh wasn't restored after a crash")
    expect(len(bpy.data.meshes) == 1, f"left {len(bpy.data.meshes)} meshes behind")


# --------------------------------------------------------------------------- exports

def textured_cube():
    reset()
    obj = mesh_from(cube, "box")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project()
    bpy.ops.object.mode_set(mode="OBJECT")
    img = bpy.data.images.new("checker", 64, 64)
    img.generated_type = "COLOR_GRID"
    img.pack()
    mat = bpy.data.materials.new("mat")
    mat.use_nodes = True
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    mat.node_tree.links.new(tex.outputs["Color"], mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    obj.data.materials.append(mat)
    return obj


for fmt in ops.FORMATS:
    @test(f"{fmt.upper()} export re-imports with the same shape, size and materials")
    def _(fmt=fmt):
        textured_cube()
        c = ctx()
        c["last_quick"] = inspector.measure(deep=False)
        ops.op_export(c, {"format": fmt, "name": f"t_{fmt}", "size_cm": 0.0})
        ops.op_validate(c, {"format": fmt, "name": f"t_{fmt}"})
        v = c["report"]["exports"][fmt]["validated"]
        expect(v["ok"], v)
        expect(len(ops.meshes()) == 1, "validation left objects in the scene")


@test("STL with a real size comes back in millimetres")
def _():
    textured_cube()
    c = ctx()
    c["last_quick"] = inspector.measure(deep=False)
    ops.op_export(c, {"format": "stl", "name": "sized", "size_cm": 12.0})
    ops.op_validate(c, {"format": "stl", "name": "sized"})
    dims = c["report"]["exports"]["stl"]["validated"]["reimported"]["dimensions_m"]
    expect(abs(max(dims) - 120.0) < 0.1, dims)


@test("validation catches a file that doesn't match")
def _():
    textured_cube()
    c = ctx()
    c["last_quick"] = inspector.measure(deep=False)
    ops.op_export(c, {"format": "glb", "name": "swap", "size_cm": 0.0})
    # Replace the exported file with a different model behind the validator's back.
    reset()
    mesh_from(lambda bm: sphere(bm))
    bpy.ops.export_scene.gltf(filepath=c["exports"]["glb"]["path"], export_format="GLB")
    textured_cube()
    try:
        ops.op_validate(c, {"format": "glb", "name": "swap"})
        raise AssertionError("a mismatching file passed validation")
    except ops.JobError:
        pass
    expect(c["report"]["exports"]["glb"]["validated"]["ok"] is False, "should be marked not ok")


# --------------------------------------------------------------------------- job checking

@test("invalid jobs are refused before anything runs")
def _():
    good = {"workdir": WORK, "steps": [{"op": "inspect"}]}
    ops.validate_job(good)
    bad = [
        {"workdir": WORK, "steps": [{"op": "exec", "code": "print(1)"}]},
        {"workdir": WORK, "steps": [{"op": "inspect", "python": "x"}]},
        {"workdir": WORK, "steps": [{"op": "repair", "max_triangles": -5}]},
        {"workdir": WORK, "steps": [{"op": "repair", "smooth_angle": float("nan")}]},
        {"workdir": WORK, "steps": [{"op": "export", "format": "exe"}]},
        {"workdir": WORK, "steps": [{"op": "export", "format": "glb", "name": "../../evil"}]},
        {"workdir": WORK, "steps": [{"op": "render_views", "views": ["front"] * 9}]},
        {"workdir": WORK, "steps": []},
        {"workdir": os.path.join(WORK, "missing"), "steps": [{"op": "inspect"}]},
        {"workdir": WORK, "input": os.path.join(WORK, "nope.glb"), "steps": [{"op": "load"}]},
    ]
    for job in bad:
        try:
            ops.validate_job(job)
        except ops.JobError:
            continue
        raise AssertionError(f"accepted a bad job: {job}")
    try:
        ops.inside(WORK, os.path.join(WORK, "..", "x.glb"))
        raise AssertionError("path escape accepted")
    except ops.JobError:
        pass


# --------------------------------------------------------------------------- real models

for path in REAL:
    @test(f"real model {os.path.basename(path)}: repair is no worse, GLB re-imports")
    def _(path=path):
        reset()
        c = ctx()
        c["input"] = path
        ops.op_load(c, {})
        ops.op_prepare(c, {"join": True})
        a = inspector.measure()
        repair(c)
        b = inspector.measure()
        for k in ("boundary_edges", "non_manifold_edges", "flipped_edges", "specks", "degenerate_triangles"):
            expect(b[k] <= a[k], f"{k}: {a[k]} → {b[k]}")
        expect(same_size(a, b, 0.02), f"size changed {a['dimensions_m']} → {b['dimensions_m']}")
        dec = [st for st in c["report"]["repair"] if st["step"].startswith("reduce")]
        if a["triangles"] > 150_000:
            # Reduction must happen; it may stop above 150k when seam vertices are locked (honest limit).
            expect(dec and dec[0]["status"] == "ok", f"reduction didn't run: {dec}")
            expect(b["triangles"] < a["triangles"] * 0.9, f"triangles {a['triangles']} → {b['triangles']}")
        else:
            expect(b["triangles"] <= a["triangles"], b["triangles"])
        c["last_quick"] = inspector.measure(deep=False)
        ops.op_export(c, {"format": "glb", "name": "real", "size_cm": 0.0})
        ops.op_validate(c, {"format": "glb", "name": "real"})
        print("   before", {k: a[k] for k in ("triangles", "boundary_edges", "holes", "flipped_edges", "islands", "specks")},
              "\n   after ", {k: b[k] for k in ("triangles", "boundary_edges", "holes", "flipped_edges", "islands", "specks")},
              "\n   rolled back:", [s["step"] for s in c["report"]["repair"] if s["status"] == "rolled_back"])


failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
for name, _, why in failed:
    print(f"  FAILED: {name}: {why}")
if failed:
    sys.exit(1)
