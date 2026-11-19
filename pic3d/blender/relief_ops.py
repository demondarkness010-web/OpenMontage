"""The operations Relief may ask Blender to do, and nothing else.

A job is JSON: {"input": file, "workdir": folder, "steps": [{"op": name, ...params}]}. Every step
is checked against OPS before anything runs: unknown operations, unknown parameters, values out
of range and output paths outside the job's folder are refused. No code is ever passed in.

Steps that change geometry go through `guarded()`: the mesh is copied first (a checkpoint), the
change is made, the inspector measures the result, and if the step's own check says it made things
worse the copy is put back (rolled back). The report records what happened to every step.
"""
import math
import os
import re
import time
import zipfile

import bmesh
import bpy

import inspector

# --------------------------------------------------------------------------- parameter checking

FORMATS = ("glb", "obj", "stl", "fbx", "ply", "usdz", "blend")
VIEWS = ("front", "back", "left", "right", "three_quarter", "top")
SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


class JobError(ValueError):
    pass


def P(kind, default=None, lo=None, hi=None, choices=None):
    return {"kind": kind, "default": default, "lo": lo, "hi": hi, "choices": choices}


OPS = {
    "load": {},  # import the job's input file into an empty scene
    "prepare": {"join": P("bool", True)},
    "inspect": {"label": P("name", "inspection"), "deep": P("bool", True)},
    "repair": {
        "merge": P("bool", True), "degenerate": P("bool", True), "loose": P("bool", True),
        "specks": P("bool", True), "holes_max_sides": P("int", 24, 0, 256), "normals": P("bool", True),
        "max_triangles": P("int", 150_000, 0, 5_000_000), "smooth_angle": P("float", 40.0, 0.0, 180.0),
    },
    "export": {"format": P("enum", None, choices=FORMATS), "name": P("name", "model"),
               "size_cm": P("float", 0.0, 0.0, 10_000.0)},
    "validate": {"name": P("name", "model"), "format": P("enum", None, choices=FORMATS)},
    "render_views": {"views": P("list", ["front", "three_quarter"], choices=VIEWS),
                     "size": P("int", 480, 64, 1600), "shading": P("enum", "clay", choices=("clay", "textured")),
                     "tag": P("name", "view")},
}


def check_value(op, key, spec, value):
    kind = spec["kind"]
    bad = JobError(f"{op}.{key}: bad value {value!r}")
    if kind == "bool":
        if not isinstance(value, bool):
            raise bad
    elif kind in ("int", "float"):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or (kind == "int" and not float(value).is_integer()):
            raise bad
        if not math.isfinite(value) or not (spec["lo"] <= value <= spec["hi"]):
            raise JobError(f"{op}.{key}: {value} is outside {spec['lo']}–{spec['hi']}")
        value = int(value) if kind == "int" else float(value)
    elif kind == "enum":
        if value not in spec["choices"]:
            raise JobError(f"{op}.{key}: must be one of {', '.join(spec['choices'])}")
    elif kind == "list":
        if not isinstance(value, list) or not value or len(value) > 8 or any(v not in spec["choices"] for v in value):
            raise JobError(f"{op}.{key}: must be a list of {', '.join(spec['choices'])}")
    elif kind == "name":
        if not isinstance(value, str) or not SAFE_NAME.match(value):
            raise JobError(f"{op}.{key}: names may only use letters, digits, - and _")
    return value


def validate_job(job):
    """Check a whole job before anything runs. Returns the steps with defaults filled in."""
    if not isinstance(job, dict):
        raise JobError("The job must be a JSON object.")
    workdir = os.path.realpath(job.get("workdir") or "")
    if not os.path.isdir(workdir):
        raise JobError("The job folder doesn't exist.")
    src = job.get("input")
    if src is not None:
        if not isinstance(src, str) or not os.path.isfile(src):
            raise JobError("The input file doesn't exist.")
        if os.path.splitext(src)[1].lower() not in (".glb", ".gltf", ".obj", ".stl", ".fbx", ".ply", ".blend"):
            raise JobError("Unsupported input type.")
    steps = job.get("steps")
    if not isinstance(steps, list) or not 0 < len(steps) <= 40:
        raise JobError("The job needs 1–40 steps.")
    clean = []
    for i, step in enumerate(steps):
        if not isinstance(step, dict) or step.get("op") not in OPS:
            raise JobError(f"Step {i + 1}: unknown operation {step.get('op') if isinstance(step, dict) else step!r}")
        op, spec = step["op"], OPS[step["op"]]
        extra = set(step) - set(spec) - {"op"}
        if extra:
            raise JobError(f"Step {i + 1} ({op}): unknown parameter(s) {', '.join(sorted(extra))}")
        params = {}
        for key, s in spec.items():
            value = step.get(key, s["default"])
            if value is None:
                raise JobError(f"Step {i + 1} ({op}): {key} is required")
            params[key] = check_value(op, key, s, value)
        clean.append((op, params))
    if any(op != "load" for op, _ in clean[:1]) and src is not None:
        raise JobError("The first step must be load.")
    return workdir, clean


def inside(workdir, path):
    path = os.path.realpath(path)
    if os.path.commonpath([workdir, path]) != workdir:
        raise JobError("Output path escapes the job folder.")
    return path


# --------------------------------------------------------------------------- helpers

def meshes():
    return inspector.mesh_objects()


def only_mesh():
    objs = meshes()
    if len(objs) != 1:
        raise JobError(f"Expected one joined mesh, found {len(objs)}. Run prepare first.")
    return objs[0]


def sorted_dims(m):
    return sorted(m.get("dimensions_m") or [0, 0, 0])


def dims_change(before, after):
    """Largest relative change of the bounding box sides (sorted, so axis order doesn't matter)."""
    b, a = sorted_dims(before), sorted_dims(after)
    scale = max(max(b), 1e-9)
    return max(abs(x - y) for x, y in zip(b, a)) / scale


def edit_bmesh(obj, fn):
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    result = fn(bm)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return result


# --------------------------------------------------------------------------- checkpoints

def guarded(ctx, name, change, accept):
    """Run `change(obj)` on a copy-protected mesh; keep it only if accept(before, after) is True.

    accept returns (ok: bool, why: str). The inspector measures before and after (quick mode).
    """
    obj = only_mesh()
    before = ctx.get("last_quick") or inspector.measure(deep=False)
    checkpoint = obj.data.copy()  # in-memory checkpoint of the whole mesh (geometry, UVs, materials)
    t0 = time.time()
    entry = {"step": name, "status": "ok"}
    try:
        detail = change(obj) or {}
        after = inspector.measure(deep=False)
        if not after.get("ok"):
            raise JobError(after.get("error") or "the mesh broke")
        ok, why = accept(before, after)
        entry.update(detail)
        if not ok:
            raise JobError(why)
        bpy.data.meshes.remove(checkpoint)
        ctx["last_quick"] = after
        entry["change"] = {k: [before.get(k), after.get(k)] for k in WATCH if before.get(k) != after.get(k)}
    except Exception as e:  # noqa: BLE001 - roll back and report, never leave a half-changed mesh
        broken = obj.data
        obj.data = checkpoint
        checkpoint.name = broken.name
        bpy.data.meshes.remove(broken)
        ctx["last_quick"] = before
        entry.update(status="rolled_back", reason=f"{e}")
    entry["seconds"] = round(time.time() - t0, 2)
    return entry


WATCH = ("vertices", "triangles", "duplicate_vertices", "degenerate_triangles", "loose_edges", "loose_vertices",
         "boundary_edges", "holes", "non_manifold_edges", "flipped_edges", "islands", "specks")


def not_worse(*keys, max_dims=0.01, max_tri_loss=None):
    """Accept when none of `keys` went up, the size stayed within max_dims, and (optionally)
    no more than max_tri_loss of the triangles were removed, not counting zero-area triangles
    (removing those is the point of cleaning, and on a small mesh one of them can be >1%)."""
    def accept(b, a):
        for k in keys:
            if (a.get(k) or 0) > (b.get(k) or 0):
                return False, f"{k} went up from {b.get(k)} to {a.get(k)}"
        d = dims_change(b, a)
        if d > max_dims:
            return False, f"the model's size changed by {d:.1%}"
        if max_tri_loss is not None:
            allowed = b["triangles"] * max_tri_loss + (b.get("degenerate_triangles") or 0)
            if b["triangles"] - a["triangles"] > allowed:
                return False, f"it removed {1 - a['triangles'] / b['triangles']:.1%} of the triangles"
        return True, ""
    return accept


# --------------------------------------------------------------------------- operations

def op_load(ctx, p):
    src = ctx["input"]
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    ext = os.path.splitext(src)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=src)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=src)
    elif ext == ".blend":
        with bpy.data.libraries.load(src) as (data_from, data_to):
            data_to.objects = data_from.objects
        for o in data_to.objects:
            if o is not None:
                bpy.context.scene.collection.objects.link(o)
    objs = meshes()
    if not objs:
        raise JobError("The file has no mesh in it.")
    return {"objects": len(bpy.context.scene.objects), "meshes": len(objs)}


def op_prepare(ctx, p):
    """Join the meshes into one object, unparent it, apply its transform, drop imported normals."""
    objs = meshes()
    for o in list(bpy.context.scene.objects):
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]
    if p["join"] and len(objs) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for o in list(bpy.context.scene.objects):
        if o is not obj:
            bpy.data.objects.remove(o, do_unlink=True)
    # glTF brings per-corner normals that stop matching once the mesh is edited (lumpy, blotchy
    # shading). Blender recomputes them.
    custom = obj.data.has_custom_normals
    if custom:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    ctx.pop("last_quick", None)
    return {"joined": len(objs), "cleared_custom_normals": custom}


def op_inspect(ctx, p):
    m = inspector.measure(deep=p["deep"])
    m["profiles"] = inspector.profiles(m)
    ctx["report"].setdefault("inspections", {})[p["label"]] = m
    if m.get("ok"):
        ctx["last_quick"] = {k: v for k, v in m.items() if k != "profiles"}
    return {"label": p["label"], "seconds": m.get("seconds")}


def border_vertices(obj):
    """Indices of vertices on edges used by only one face (seams and open borders)."""
    import numpy as np
    me = obj.data
    if not len(me.loops):
        return None
    le = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get("edge_index", le)
    uses = np.bincount(le, minlength=len(me.edges))
    ev = np.empty(len(me.edges) * 2, np.int32)
    me.edges.foreach_get("vertices", ev)
    return np.unique(ev.reshape(-1, 2)[uses == 1].reshape(-1))


def op_repair(ctx, p):
    steps = []
    obj = only_mesh()
    if not ctx.get("last_quick"):
        ctx["last_quick"] = inspector.measure(deep=False)  # reused as the first step's "before"
    diag = ctx["last_quick"].get("diagonal_m") or 1.0

    def nothing(*keys):
        """True when the latest measurement found none of `keys`: running that step would only cost
        time (30-70 s each on a 450k-triangle model) and risk harm for no gain."""
        m = ctx["last_quick"]
        return all(not m.get(k) for k in keys)

    def skip(name, why):
        steps.append({"step": name, "status": "skipped", "reason": why})

    if p["merge"] and nothing("duplicate_vertices"):
        skip("merge doubled vertices", "none measured")
    elif p["merge"]:
        def merge(o):
            # Weld seam copies only: glTF splits vertices along UV seams at exactly the same spot.
            # A looser distance also collapses real thin triangles (on a TRELLIS model it opened
            # 429 edges), which then got undone and left every later step on an unwelded mesh.
            n = edit_bmesh(o, lambda bm: (len(bm.verts), bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=diag * 1e-7), len(bm.verts)))
            return {"merged": n[0] - n[2]}
        steps.append(guarded(ctx, "merge doubled vertices", merge,
                             not_worse("duplicate_vertices", "boundary_edges", max_tri_loss=0.01)))
    if p["degenerate"] and nothing("degenerate_triangles"):
        skip("remove zero-size faces", "none measured")
    elif p["degenerate"]:
        def degenerate(o):
            edit_bmesh(o, lambda bm: bmesh.ops.dissolve_degenerate(bm, dist=diag * 1e-6, edges=bm.edges))
        steps.append(guarded(ctx, "remove zero-size faces", degenerate,
                             not_worse("degenerate_triangles", max_tri_loss=0.02)))
    if p["loose"] and nothing("loose_edges", "loose_vertices"):
        skip("remove loose edges and points", "none measured")
    elif p["loose"]:
        def loose(o):
            def fn(bm):
                le = [e for e in bm.edges if not e.link_faces]
                bmesh.ops.delete(bm, geom=le, context="EDGES")
                lv = [v for v in bm.verts if not v.link_faces]
                bmesh.ops.delete(bm, geom=lv, context="VERTS")
                return len(le) + len(lv)
            return {"removed": edit_bmesh(o, fn)}
        steps.append(guarded(ctx, "remove loose edges and points", loose,
                             not_worse("loose_edges", "loose_vertices", max_dims=1.0, max_tri_loss=0.0)))
    def specks(o):
        # Same rule the inspector counts with (merged vertices, so seams don't split pieces).
        faces = set(inspector.speck_faces(o))

        def fn(bm):
            bm.faces.ensure_lookup_table()
            gone = [bm.faces[i] for i in faces]
            if gone:
                bmesh.ops.delete(bm, geom=gone, context="FACES")
            return len(gone)
        return {"removed_faces": edit_bmesh(o, fn) if faces else 0}

    def accept_specks(b, a):
        # Exactly the specks must go: no more pieces lost than there were specks, and the
        # main piece keeps every triangle.
        if a["specks"] > 0 and a["specks"] >= b["specks"]:
            return False, "specks weren't removed"
        if b["islands"] - a["islands"] > b["specks"]:
            return False, f"it removed {b['islands'] - a['islands']} pieces but only {b['specks']} were specks"
        if a.get("largest_island_triangles", 0) < b.get("largest_island_triangles", 0):
            return False, "it cut into the main piece"
        # removing a stray speck may shrink the box; it must never grow
        if any(x > y * 1.001 + 1e-9 for x, y in zip(sorted_dims(a), sorted_dims(b))):
            return False, "the model got bigger"
        return True, ""

    if p["specks"] and nothing("specks"):
        skip("remove floating specks", "none measured")
    elif p["specks"]:
        steps.append(guarded(ctx, "remove floating specks", specks, accept_specks))
    if p["holes_max_sides"] > 2 and nothing("holes"):
        skip(f"fill holes up to {p['holes_max_sides']} edges", "no holes measured")
    elif p["holes_max_sides"] > 2:
        def holes(o):
            def fn(bm):
                # Only TRUE holes. An unwelded mesh (UV seams split, or a merge that was undone)
                # has a border edge on both sides of every seam; those have a twin at the same
                # spot and aren't holes. Feeding thousands of them to holes_fill hangs it.
                q = diag * 1e-5

                def key(e):
                    a, b = (tuple(round(c / q) for c in v.co) for v in e.verts)
                    return (a, b) if a <= b else (b, a)
                boundary = [e for e in bm.edges if e.is_boundary]
                seen = {}
                for e in boundary:
                    k = key(e)
                    seen[k] = seen.get(k, 0) + 1
                boundary = [e for e in boundary if seen[key(e)] == 1]
                if not boundary:
                    return 0
                if len(boundary) > 20_000:
                    raise JobError(f"{len(boundary)} open edges: too many to be small holes, left as they are")
                filled = bmesh.ops.holes_fill(bm, edges=boundary, sides=p["holes_max_sides"])["faces"]
                new = set(filled)
                layers = list(bm.loops.layers.uv.values()) + list(bm.loops.layers.color.values()) \
                    + list(bm.loops.layers.float_color.values())
                for f in filled:
                    for loop in f.loops:
                        donor = next((l for l in loop.vert.link_loops if l.face not in new), None)
                        if donor:
                            for layer in layers:
                                loop[layer] = donor[layer]
                    near = next((l.face for l in f.loops[0].vert.link_loops if l.face not in new), None)
                    if near:
                        f.material_index = near.material_index
                return len(filled)
            return {"filled": edit_bmesh(o, fn)}
        steps.append(guarded(ctx, f"fill holes up to {p['holes_max_sides']} edges", holes,
                             not_worse("boundary_edges", "non_manifold_edges")))
    if p["normals"] and nothing("flipped_edges", "inside_out"):
        skip("point faces outward", "all faces already agree")
    elif p["normals"]:
        def normals(o):
            edit_bmesh(o, lambda bm: bmesh.ops.recalc_face_normals(bm, faces=bm.faces))

        def accept_normals(b, a):
            if a["flipped_edges"] > b["flipped_edges"]:
                return False, "more faces disagree than before"
            if a.get("inside_out") and not b.get("inside_out"):
                return False, "it turned the model inside out"
            return not_worse(max_dims=1e-6)(b, a)
        steps.append(guarded(ctx, "point faces outward", normals, accept_normals))
    if p["max_triangles"]:
        def decimate(o):
            o.data.calc_loop_triangles()
            tris = len(o.data.loop_triangles)
            if tris <= p["max_triangles"]:
                return {"skipped": f"already {tris} triangles"}
            mod = o.modifiers.new("Decimate", "DECIMATE")
            mod.decimate_type = "COLLAPSE"
            mod.ratio = p["max_triangles"] / tris
            mod.use_collapse_triangulate = True
            # Border vertices (UV seams that couldn't be welded, and real open edges) get weight 0
            # so they never collapse. Otherwise each side of a seam collapses differently, the
            # seam cracks open and the model falls apart (a TRELLIS cart went from 74 to 418 pieces).
            locked = border_vertices(o)
            if locked is not None and len(locked):
                group = o.vertex_groups.new(name="relief_keep")
                group.add(range(len(o.data.vertices)), 1.0, "REPLACE")
                group.add(locked.tolist(), 0.0, "REPLACE")
                mod.vertex_group = group.name
                mod.vertex_group_factor = 1000.0
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_apply(modifier=mod.name)
            if locked is not None and len(locked):
                o.vertex_groups.remove(o.vertex_groups["relief_keep"])
            return {"from": tris, "border_vertices_kept": int(len(locked)) if locked is not None else 0}

        def accept_decimate(b, a):
            if a["triangles"] > max(p["max_triangles"] * 1.02, b["triangles"]):
                return False, "the triangle count didn't come down"
            if a["islands"] > b["islands"] * 1.1 + 5:
                return False, f"it broke the model into pieces ({b['islands']} → {a['islands']})"
            if a["boundary_edges"] > b["boundary_edges"] * 1.5 + 50:
                return False, f"it tore open edges ({b['boundary_edges']} → {a['boundary_edges']})"
            return not_worse(max_dims=0.02)(b, a)
        steps.append(guarded(ctx, f"reduce to {p['max_triangles']:,} triangles", decimate, accept_decimate))
        if p["specks"] and not nothing("specks"):  # collapsing can leave a few tiny bits behind
            steps.append(guarded(ctx, "remove specks left by the reduction", specks, accept_specks))
    if p["smooth_angle"]:
        try:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(p["smooth_angle"]))
            steps.append({"step": f"smooth shading (keep creases over {p['smooth_angle']:g}°)", "status": "ok"})
        except (AttributeError, RuntimeError) as e:
            steps.append({"step": "smooth shading", "status": "failed", "reason": str(e)})
    ctx["report"]["repair"] = steps
    return {"rolled_back": sum(s["status"] == "rolled_back" for s in steps), "steps": len(steps)}


def _export_file(ctx, fmt, name):
    workdir = ctx["workdir"]
    folder = inside(workdir, os.path.join(workdir, f"export-{fmt}"))
    os.makedirs(folder, exist_ok=True)
    ext = {"glb": ".glb", "obj": ".obj", "stl": ".stl", "fbx": ".fbx", "ply": ".ply", "usdz": ".usdz", "blend": ".blend"}[fmt]
    return folder, inside(workdir, os.path.join(folder, name + ext))


class textures_on_disk:
    """OBJ and FBX exporters copy texture *files*. glTF textures (and generated ones) live packed
    inside Blender with no file, so they'd be silently dropped. Write each one's bytes into
    `folder` and point the image at that file for the export, then put the old path back."""

    def __init__(self, ctx, folder):
        self.ctx, self.folder, self.saved = ctx, folder, []

    def __enter__(self):
        used = 0
        for img in bpy.data.images:
            if img.type not in ("IMAGE", "UV_TEST") or img.size[0] == 0:
                continue
            path = bpy.path.abspath(img.filepath) if img.filepath else ""
            if not img.packed_file and path and os.path.isfile(path):
                continue  # a real file already: the exporter can copy it
            used += 1
            safe = re.sub(r"[^A-Za-z0-9_-]", "_", os.path.splitext(img.name)[0])[:40] or f"texture{used}"
            if img.packed_file:
                data = bytes(img.packed_file.data)
                ext = ".jpg" if data[:3] == b"\xff\xd8\xff" else ".png"
                out = inside(self.ctx["workdir"], os.path.join(self.folder, safe + ext))
                with open(out, "wb") as f:
                    f.write(data)
            else:  # generated in Blender, never saved: write its pixels as PNG
                out = inside(self.ctx["workdir"], os.path.join(self.folder, safe + ".png"))
                copy = img.copy()
                copy.filepath_raw = out
                copy.file_format = "PNG"
                copy.save()
                bpy.data.images.remove(copy)
            self.saved.append((img, img.filepath_raw, img.source))
            img.filepath_raw = out
            if img.source != "FILE":  # exporters only copy images that come from a file
                img.source = "FILE"
        return self

    def __exit__(self, *exc):
        for img, fp, source in self.saved:
            img.filepath_raw = fp
            if img.source != source:
                img.source = source
        return False


def op_export(ctx, p):
    fmt, name = p["format"], p["name"]
    folder, path = _export_file(ctx, fmt, name)
    m = ctx.get("last_quick") or inspector.measure(deep=False)
    # Real-size STL: scale so the longest side is size_cm, written in millimetres.
    scale = 1.0
    if p["size_cm"] and fmt in ("stl", "obj", "fbx", "ply"):
        longest = max(m["dimensions_m"]) or 1.0
        scale = (p["size_cm"] / 100.0) / longest
        if fmt == "stl":
            scale *= 1000.0  # STL has no units; printers read millimetres
    for o in bpy.context.scene.objects:
        o.select_set(o.type == "MESH")
    if fmt == "glb":
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=False, export_apply=True)
    elif fmt == "obj":
        with textures_on_disk(ctx, folder):
            bpy.ops.wm.obj_export(filepath=path, global_scale=scale, path_mode="RELATIVE", export_materials=True)
    elif fmt == "stl":
        bpy.ops.wm.stl_export(filepath=path, global_scale=scale, ascii_format=False)
    elif fmt == "fbx":
        tex = os.path.join(folder, "_textures")
        os.makedirs(tex, exist_ok=True)
        with textures_on_disk(ctx, tex):
            bpy.ops.export_scene.fbx(filepath=path, global_scale=scale, path_mode="COPY", embed_textures=True,
                                     apply_unit_scale=True, mesh_smooth_type="FACE")
        for f in os.listdir(tex):  # they're embedded in the .fbx now
            os.remove(os.path.join(tex, f))
        os.rmdir(tex)
    elif fmt == "ply":
        bpy.ops.wm.ply_export(filepath=path, global_scale=scale, export_colors="SRGB")
    elif fmt == "usdz":
        bpy.ops.wm.usd_export(filepath=path, export_materials=True, export_textures=True)
    elif fmt == "blend":
        try:
            bpy.ops.file.pack_all()
        except RuntimeError:
            pass
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)
    if not os.path.isfile(path):
        raise JobError(f"Blender didn't write the {fmt.upper()} file.")
    files = sorted(f for f in os.listdir(folder) if f != os.path.basename(path) + ".zip")
    download = path
    if len(files) > 1:  # OBJ + .mtl + textures: zip them so it's one download
        download = inside(ctx["workdir"], os.path.join(ctx["workdir"], f"{name}-{fmt}.zip"))
        with zipfile.ZipFile(download, "w", zipfile.ZIP_DEFLATED) as z:
            for f in files:
                z.write(os.path.join(folder, f), f)
    expect = {"triangles": m["triangles"], "dimensions_m": [d * scale for d in m["dimensions_m"]],
              "materials": m.get("materials", 0), "textures": m.get("textures", 0)}
    ctx.setdefault("exports", {})[fmt] = {"path": path, "expect": expect, "scale": scale}
    entry = {"format": fmt, "file": os.path.relpath(download, ctx["workdir"]).replace("\\", "/"),
             "bytes": os.path.getsize(download), "files": files, "scale": scale, "validated": None}
    ctx["report"].setdefault("exports", {})[fmt] = entry
    return {"format": fmt, "bytes": entry["bytes"]}


def op_validate(ctx, p):
    """Import the exported file into an empty collection and compare it with what was exported."""
    fmt = p["format"]
    info = (ctx.get("exports") or {}).get(fmt)
    entry = (ctx["report"].get("exports") or {}).get(fmt)
    if not info or not entry:
        raise JobError(f"Nothing was exported as {fmt} in this job.")
    path, expect = info["path"], info["expect"]
    coll = bpy.data.collections.new("validate")
    bpy.context.scene.collection.children.link(coll)
    view = bpy.context.view_layer
    keep_active = view.active_layer_collection
    view.active_layer_collection = view.layer_collection.children[coll.name]
    before_objs = set(bpy.data.objects)
    problems = []
    try:
        if fmt == "glb":
            bpy.ops.import_scene.gltf(filepath=path)
        elif fmt == "obj":
            bpy.ops.wm.obj_import(filepath=path, global_scale=1.0)
        elif fmt == "stl":
            bpy.ops.wm.stl_import(filepath=path, global_scale=1.0)
        elif fmt == "fbx":
            bpy.ops.import_scene.fbx(filepath=path)
        elif fmt == "ply":
            bpy.ops.wm.ply_import(filepath=path)
        elif fmt == "usdz":
            bpy.ops.wm.usd_import(filepath=path)
        elif fmt == "blend":
            with bpy.data.libraries.load(path) as (data_from, data_to):
                data_to.objects = data_from.objects
            for o in data_to.objects:
                if o is not None:
                    coll.objects.link(o)
        new = [o for o in bpy.data.objects if o not in before_objs]
        got = inspector.measure(objects=[o for o in new if o.type == "MESH"], deep=False)
        if not got.get("ok"):
            problems.append(got.get("error") or "no mesh came back")
        else:
            t0, t1 = expect["triangles"], got["triangles"]
            if abs(t1 - t0) > max(2, t0 * 0.01):
                problems.append(f"triangles {t0} → {t1}")
            e, g = sorted(expect["dimensions_m"]), sorted(got["dimensions_m"])
            rel = max(abs(x - y) for x, y in zip(e, g)) / max(max(e), 1e-9)
            if rel > 0.01:
                problems.append(f"size changed by {rel:.1%} ({[round(x, 4) for x in e]} → {[round(x, 4) for x in g]})")
            keeps_materials = fmt in ("glb", "fbx", "obj", "usdz", "blend")
            if keeps_materials and expect["materials"] and not got["materials"]:
                problems.append("the materials were lost")
            if fmt in ("glb", "blend", "usdz", "fbx", "obj") and expect["textures"] and not got["textures"]:
                problems.append("the textures were lost")
            if got.get("missing_texture_count"):
                problems.append(f"{got['missing_texture_count']} texture(s) missing after re-import")
        result = {"ok": not problems, "problems": problems,
                  "reimported": {k: got.get(k) for k in ("triangles", "dimensions_m", "materials", "textures")}
                  if got.get("ok") else None}
    finally:
        for o in [o for o in bpy.data.objects if o not in before_objs]:
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(coll)
        view.active_layer_collection = keep_active
        try:
            bpy.data.orphans_purge(do_recursive=True)
        except (AttributeError, TypeError):
            pass
    entry["validated"] = result
    if not result["ok"]:
        raise JobError(f"{fmt.upper()} didn't survive re-import: " + "; ".join(problems))
    return {"format": fmt, "ok": True}


def op_render_views(ctx, p):
    """Quick inspection pictures with Workbench (seconds, not minutes like Cycles on this laptop)."""
    from mathutils import Vector
    objs = meshes()
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector([min(q[i] for q in pts) for i in range(3)])
    hi = Vector([max(q[i] for q in pts) for i in range(3)])
    centre, radius = (lo + hi) / 2, max((hi - lo).length / 2, 1e-6)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "TEXTURE" if p["shading"] == "textured" else "SINGLE"
    shading.single_color = (0.8, 0.78, 0.74)
    shading.show_cavity = True
    shading.show_object_outline = False
    scene.render.resolution_x = p["size"]
    scene.render.resolution_y = round(p["size"] * 0.75)
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    cam_data = bpy.data.cameras.new("InspectCam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("InspectCam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    angles = {"front": (0, 8), "back": (180, 8), "left": (-90, 8), "right": (90, 8),
              "three_quarter": (35, 22), "top": (0, 80)}
    written = []
    try:
        for view in p["views"]:
            yaw, pitch = (math.radians(a) for a in angles[view])
            d = radius / math.tan(cam_data.angle / 2) * 1.15
            offset = Vector((math.sin(yaw) * math.cos(pitch), -math.cos(yaw) * math.cos(pitch), math.sin(pitch))) * d
            cam.location = centre + offset
            cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
            name = f"{p['tag']}-{view}-{p['shading']}.png"
            scene.render.filepath = inside(ctx["workdir"], os.path.join(ctx["workdir"], name))
            bpy.ops.render.render(write_still=True)
            if os.path.isfile(scene.render.filepath):
                written.append(name)
    finally:
        bpy.data.objects.remove(cam, do_unlink=True)
        bpy.data.cameras.remove(cam_data)
    ctx["report"].setdefault("renders", []).extend(written)
    if not written:
        raise JobError("Workbench didn't write any picture.")
    return {"renders": written}


RUN = {"load": op_load, "prepare": op_prepare, "inspect": op_inspect, "repair": op_repair,
       "export": op_export, "validate": op_validate, "render_views": op_render_views}
