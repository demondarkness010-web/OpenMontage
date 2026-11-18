"""Clean and fix an AI-made 3D model with Blender, running hidden in the background.

    blender -b --factory-startup -P blender_clean.py -- in.glb out.glb report.json [max_triangles]

Image-to-3D engines leave the same problems behind: floating specks around the model, doubled
vertices along seams, tiny holes, flipped faces and far more triangles than a laptop needs to
spin the model smoothly. This fixes those and keeps the textures and colours:

  1. join the parts into one mesh and apply their transforms
  2. merge doubled vertices, drop zero-size faces and loose edges/points
  3. delete floating islands (tiny bits not attached to the model)
  4. fill small holes, giving the patch the colours/UVs of the edge around it
  5. point every face outward
  6. reduce the triangle count to `max_triangles` (default 150k) when it's above that
  7. smooth shading, keeping sharp creases

and writes a JSON report of what it changed.
"""
import json
import math
import sys
import time

import bmesh
import bpy

t0 = time.time()
argv = sys.argv[sys.argv.index("--") + 1:]
src, dst, report_path = argv[:3]
max_tris = int(argv[3]) if len(argv) > 3 else 150_000
report = {"ok": False}


def save_report():
    report["seconds"] = round(time.time() - t0, 1)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)


def counts(me):
    me.calc_loop_triangles()
    return {"vertices": len(me.vertices), "triangles": len(me.loop_triangles)}


def components(bm):
    """Groups of faces that touch each other, largest first."""
    seen = set()
    groups = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, group = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            group.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        groups.append(group)
    groups.sort(key=len, reverse=True)
    return groups


try:
    # ---- load
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("The model has no mesh in it.")
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    # Unparent (glTF imports often sit under an empty) and bake the transforms in.
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for o in list(bpy.context.scene.objects):
        if o is not obj:
            bpy.data.objects.remove(o, do_unlink=True)
    me = obj.data
    # glTF brings its own per-corner normals. They stop matching the surface as soon as the
    # mesh is edited or reduced, which shows as dark blotches and lumpy-looking tubes, and
    # Blender's own smoothing is ignored while they exist. Drop them and recompute.
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    report["before"] = counts(me)
    report["parts_joined"] = len(meshes)

    dims = obj.dimensions
    diag = math.sqrt(dims.x ** 2 + dims.y ** 2 + dims.z ** 2) or 1.0

    # ---- clean in bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    v0 = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=diag * 1e-5)
    report["merged_vertices"] = v0 - len(bm.verts)
    bmesh.ops.dissolve_degenerate(bm, dist=diag * 1e-6, edges=bm.edges)
    loose_e = [e for e in bm.edges if not e.link_faces]
    bmesh.ops.delete(bm, geom=loose_e, context="EDGES")
    loose_v = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose_v, context="VERTS")
    report["loose_removed"] = len(loose_e) + len(loose_v)

    # Floating islands: keep real parts (a separate arm, a chain, a wire bar that broke off),
    # drop specks of noise. A speck is small in BOTH ways: few faces and a tiny size. A loose
    # wire bar has few faces too, but it's long, so it stays.
    bm.faces.ensure_lookup_table()
    groups = components(bm)
    total = len(bm.faces)
    keep_min = max(24, int(total * 0.002))

    def extent(group):
        pts = [v.co for f in group for v in f.verts]
        lo = [min(p[i] for p in pts) for i in range(3)]
        hi = [max(p[i] for p in pts) for i in range(3)]
        return math.dist(lo, hi)

    specks = [g for g in groups[1:] if len(g) < keep_min and extent(g) < diag * 0.03]
    if specks:
        bmesh.ops.delete(bm, geom=[f for g in specks for f in g], context="FACES")
    report["islands_removed"] = len(specks)
    report["parts_kept"] = len(groups) - len(specks)

    # Small holes only (up to 24 edges round): big openings are usually meant to be there.
    boundary = [e for e in bm.edges if e.is_boundary]
    report["open_edges_before"] = len(boundary)
    filled = bmesh.ops.holes_fill(bm, edges=boundary, sides=24)["faces"]
    report["holes_filled"] = len(filled)
    if filled:
        new = set(filled)
        layers = list(bm.loops.layers.uv.values()) + list(bm.loops.layers.color.values()) \
            + list(bm.loops.layers.float_color.values())
        for f in filled:
            for loop in f.loops:
                donor = next((l for l in loop.vert.link_loops if l.face not in new), None)
                if donor:
                    for layer in layers:
                        loop[layer] = donor[layer]
            # Material of the faces around the hole, not slot 0.
            near = next((l.face for l in f.loops[0].vert.link_loops if l.face not in new), None)
            if near:
                f.material_index = near.material_index
    report["open_edges_after"] = sum(1 for e in bm.edges if e.is_boundary)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()

    # ---- fewer triangles, when there are far too many for a laptop
    tris = counts(me)["triangles"]
    if tris > max_tris:
        mod = obj.modifiers.new("Decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = max_tris / tris
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
        report["decimated_from"] = tris

    # ---- shading: smooth, but keep creases sharper than 40 degrees
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    except (AttributeError, RuntimeError):
        bpy.ops.object.shade_smooth()

    report["after"] = counts(me)
    report["materials"] = len(me.materials)
    report["textures"] = sum(1 for i in bpy.data.images if i.size[0] > 0)

    bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", use_selection=False,
                              export_apply=True, export_yup=True)
    report["ok"] = True
except Exception as e:  # noqa: BLE001 - reported to the app
    report["error"] = f"{type(e).__name__}: {e}"
finally:
    save_report()
