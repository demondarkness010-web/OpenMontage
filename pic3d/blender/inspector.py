"""Measure a model's geometry inside Blender. It only measures: nothing here changes the scene.

Every number in the report comes from counting the actual mesh; checks that aren't run are listed
under "not_measured" instead of being guessed. The profile scores are a plain formula on those
numbers: (passed + half of warnings) / checks that were measured.

Works on the evaluated meshes (modifiers applied) in world space, with numpy (bundled in Blender),
so a 150k-triangle model measures in a second or two on a slow laptop.
"""
import math
import time

import bpy
import numpy as np


def mesh_objects(objects=None):
    objs = objects if objects is not None else bpy.context.scene.objects
    return [o for o in objs if o.type == "MESH"]


def _gather(objs):
    """World-space vertex coordinates, edges, loops and triangles of all meshes, joined."""
    dg = bpy.context.evaluated_depsgraph_get() if any(o.modifiers for o in objs) else None
    co, edges, loop_v, loop_e, tris, tri_loops, uv, poly_mat = [], [], [], [], [], [], [], []
    no_uv_objects = 0
    bad_material_faces = 0
    nv = ne = nl = 0
    for o in objs:
        # Without modifiers the object's own mesh is the final shape: read it directly instead of
        # making a full evaluated copy (that copy is most of the time on a 450k-triangle model).
        ev = o.evaluated_get(dg) if o.modifiers else None
        me = ev.to_mesh() if ev else o.data
        try:
            v = np.empty(len(me.vertices) * 3, np.float32)
            me.vertices.foreach_get("co", v)
            v = v.reshape(-1, 3).astype(np.float64)
            m = np.array(o.matrix_world, np.float64)
            v = v @ m[:3, :3].T + m[:3, 3]
            e = np.empty(len(me.edges) * 2, np.int32)
            me.edges.foreach_get("vertices", e)
            lv = np.empty(len(me.loops), np.int32)
            le = np.empty(len(me.loops), np.int32)
            me.loops.foreach_get("vertex_index", lv)
            me.loops.foreach_get("edge_index", le)
            me.calc_loop_triangles()
            t = np.empty(len(me.loop_triangles) * 3, np.int32)
            tl = np.empty(len(me.loop_triangles) * 3, np.int32)
            me.loop_triangles.foreach_get("vertices", t)
            me.loop_triangles.foreach_get("loops", tl)
            if me.uv_layers.active:
                u = np.empty(len(me.loops) * 2, np.float32)
                me.uv_layers.active.data.foreach_get("uv", u)
                uv.append(u.reshape(-1, 2).astype(np.float64))
            else:
                no_uv_objects += 1
                uv.append(np.full((len(me.loops), 2), np.nan))
            pm = np.empty(len(me.polygons), np.int32)
            me.polygons.foreach_get("material_index", pm)
            slots = len(o.material_slots)
            bad_material_faces += int((pm >= max(slots, 1)).sum()) if len(pm) else 0
            co.append(v)
            edges.append(e.reshape(-1, 2).astype(np.int64) + nv)
            loop_v.append(lv.astype(np.int64) + nv)
            loop_e.append(le.astype(np.int64) + ne)
            tris.append(t.reshape(-1, 3).astype(np.int64) + nv)
            tri_loops.append(tl.reshape(-1, 3).astype(np.int64) + nl)
            nv += len(v)
            ne += len(me.edges)
            nl += len(me.loops)
        finally:
            if ev:
                ev.to_mesh_clear()
    cat = lambda parts, shape: np.concatenate(parts) if parts else np.empty(shape)  # noqa: E731
    return {
        "co": cat(co, (0, 3)), "edges": cat(edges, (0, 2)).astype(np.int64),
        "loop_v": cat(loop_v, (0,)).astype(np.int64), "loop_e": cat(loop_e, (0,)).astype(np.int64),
        "tris": cat(tris, (0, 3)).astype(np.int64), "tri_loops": cat(tri_loops, (0, 3)).astype(np.int64),
        "uv": cat(uv, (0, 2)), "no_uv_objects": no_uv_objects, "bad_material_faces": bad_material_faces,
    }


def _group(index, n=None):
    """Sort once so that many scatter-min/max calls on the same index are fast (np.minimum.at is slow)."""
    order = np.argsort(index, kind="stable")
    s = index[order]
    starts = np.flatnonzero(np.r_[True, s[1:] != s[:-1]]) if len(s) else np.empty(0, np.int64)
    return order, starts, s[starts] if len(s) else s


def _scatter(group, values, out, fn):
    order, starts, targets = group
    if len(starts):
        red = fn.reduceat(values[order], starts, axis=0)
        out[targets] = fn(out[targets], red)
    return out


def _components(n, pairs):
    """Connected components of n nodes joined by index pairs (min-label propagation + pointer jumping)."""
    # Hook each edge's larger root under its smaller root, then jump pointers until every node
    # points straight at its root. Each round at least halves the number of trees, so long thin
    # parts (wire bars, tubes) take a handful of rounds, not one per vertex along the bar.
    label = np.arange(n, dtype=np.int64)
    if len(pairs) == 0:
        return label
    a, b = pairs[:, 0].astype(np.int64), pairs[:, 1].astype(np.int64)
    for _ in range(64):
        la, lb = label[a], label[b]
        differ = la != lb
        if not differ.any():
            break
        a, b, la, lb = a[differ], b[differ], la[differ], lb[differ]  # settled edges stay settled
        hi, lo = np.maximum(la, lb), np.minimum(la, lb)
        np.minimum.at(label, hi, lo)
        while True:
            jumped = label[label]
            if np.array_equal(jumped, label):
                break
            label = jumped
    return label


def _row_keys(rows):
    """One int64 per row of small non-negative ints, so np.unique doesn't have to sort whole rows."""
    rows = rows.astype(np.int64)
    key = np.zeros(len(rows), np.int64)
    for i in range(rows.shape[1]):
        key = key * (int(rows[:, i].max()) + 1 if len(rows) else 1) + rows[:, i]
    return key


def _textures(objs):
    images, missing = {}, []
    materials = set()
    empty_slots = 0
    for o in objs:
        for slot in o.material_slots:
            if slot.material is None:
                empty_slots += 1
                continue
            materials.add(slot.material.name)
            nt = slot.material.node_tree if slot.material.use_nodes else None
            for node in (nt.nodes if nt else []):
                if node.type != "TEX_IMAGE":
                    continue
                img = node.image
                if img is None:
                    missing.append(f"{slot.material.name}: empty image node")
                    continue
                w, h = img.size[:]
                has = bool(img.packed_file) or (w > 0 and h > 0)
                if not has and img.filepath:
                    try:
                        has = bool(img.filepath) and __import__("os").path.isfile(bpy.path.abspath(img.filepath))
                    except Exception:  # noqa: BLE001
                        has = False
                if not has:
                    missing.append(img.name)
                images[img.name] = [w, h]
    return {
        "materials": len(materials), "empty_material_slots": empty_slots,
        "textures": len(images), "texture_max_px": max((max(s) for s in images.values()), default=0),
        "missing_textures": missing[:20], "missing_texture_count": len(missing),
    }


def measure(objects=None, deep=True):
    """Return measured facts about the meshes. deep=False skips the slower self-intersection test."""
    t0 = time.time()
    objs = mesh_objects(objects)
    not_measured = ["wall thickness", "UV overlap"]
    if not objs:
        return {"ok": False, "error": "There's no mesh in the scene.", "objects": 0}
    g = _gather(objs)
    co, edges, tris = g["co"], g["edges"], g["tris"]
    V, E, T = len(co), len(edges), len(tris)
    out = {"ok": True, "objects": len(objs), "vertices": V, "edges": E, "triangles": T,
           "faces": int(sum(len(o.data.polygons) for o in objs))}
    if V == 0 or T == 0:
        out.update(ok=False, error="The mesh has no faces.")
        return out

    lo, hi = co.min(0), co.max(0)
    dims = hi - lo
    diag = float(np.linalg.norm(dims)) or 1.0
    out["dimensions_m"] = [round(float(d), 6) for d in dims]
    out["bbox_min"] = [round(float(x), 6) for x in lo]
    out["bbox_max"] = [round(float(x), 6) for x in hi]
    out["diagonal_m"] = round(diag, 6)

    # Vertices at the same spot (within a 1e-5 of the model's size). glTF splits vertices along UV
    # seams on purpose, so a raw import usually has many; they're harmless for viewing, not for printing.
    q = np.round((co - lo) / (diag * 1e-5)).astype(np.int64)
    q -= q.min(0)
    _, inverse = np.unique(_row_keys(q), return_inverse=True)
    inverse = inverse.reshape(-1)
    unique_v = int(inverse.max()) + 1
    out["duplicate_vertices"] = V - unique_v

    # Faces with no area (two corners in one spot, or all in a line).
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    out["degenerate_triangles"] = int((area2 * 0.5 <= (diag * 1e-6) ** 2).sum())
    out["surface_area_m2"] = round(float(area2.sum() * 0.5), 6)

    # Loose geometry, on the mesh as stored.
    raw_edge_faces = np.bincount(g["loop_e"], minlength=E)
    out["loose_edges"] = int((raw_edge_faces == 0).sum())
    vert_edges = np.bincount(edges.reshape(-1), minlength=V) if E else np.zeros(V, np.int64)
    out["loose_vertices"] = int((vert_edges == 0).sum())

    # Topology is judged on MERGED vertices: exporters split vertices along UV seams on purpose,
    # which would otherwise look like thousands of open edges on a closed model.
    # Edge use: 1 face = open border (a hole or an open edge), >2 = non-manifold.
    me_pairs = np.sort(inverse[edges], axis=1) if E else np.empty((0, 2), np.int64)
    collapsed = me_pairs[:, 0] == me_pairs[:, 1]
    _, edge_map = np.unique(_row_keys(me_pairs), return_inverse=True)
    edge_map = edge_map.reshape(-1)
    edge_map[collapsed] = -1
    loop_me = edge_map[g["loop_e"]] if E else np.empty(0, np.int64)
    keep = loop_me >= 0
    loop_me, loop_start = loop_me[keep], inverse[g["loop_v"][keep]]
    n_me = int(edge_map.max()) + 1 if E and (edge_map >= 0).any() else 0
    edge_faces = np.bincount(loop_me, minlength=n_me)
    used_me = np.zeros(n_me, bool)
    used_me[edge_map[edge_map >= 0]] = True
    boundary = (edge_faces == 1) & used_me
    out["boundary_edges"] = int(boundary.sum())
    out["non_manifold_edges"] = int((edge_faces > 2).sum())
    out["seam_split_edges"] = int(E - n_me - int(collapsed.sum()))

    # Holes = separate rings of open edges.
    first_pair = np.zeros((n_me, 2), np.int64)
    first_pair[edge_map[edge_map >= 0]] = me_pairs[edge_map >= 0]
    b_edges = first_pair[boundary]
    if len(b_edges):
        lab = _components(unique_v, b_edges)
        out["holes"] = int(len(np.unique(lab[b_edges[:, 0]])))
    else:
        out["holes"] = 0

    # Flipped faces: across a shared edge, two faces that agree on which side is "out" walk the
    # edge in opposite directions. Same direction = one of them is flipped.
    order = np.argsort(loop_me, kind="stable")
    le_sorted = loop_me[order]
    two = np.flatnonzero(edge_faces == 2)
    if len(two):
        first = np.searchsorted(le_sorted, two)
        start_a = loop_start[order[first]]
        start_b = loop_start[order[first + 1]]
        out["flipped_edges"] = int((start_a == start_b).sum())
    else:
        out["flipped_edges"] = 0

    # Separate pieces (on merged vertices) and specks: tiny pieces that are small in face count
    # AND size. The largest piece is never a speck.
    used = np.zeros(unique_v, bool)
    used[inverse[tris.reshape(-1)]] = True
    m_edges = inverse[edges] if E else np.empty((0, 2), np.int64)
    lab = _components(unique_v, m_edges)
    tri_lab = lab[inverse[tris[:, 0]]]
    labels, tri_counts = np.unique(tri_lab, return_counts=True)
    out["islands"] = int(len(labels))
    ulo = np.full((unique_v, 3), np.inf)
    uhi = np.full((unique_v, 3), -np.inf)
    g_inv = _group(inverse)
    _scatter(g_inv, co, ulo, np.minimum)
    _scatter(g_inv, co, uhi, np.maximum)
    plo = np.full((unique_v, 3), np.inf)
    phi = np.full((unique_v, 3), -np.inf)
    g_lab = _group(lab)
    _scatter(g_lab, ulo, plo, np.minimum)
    _scatter(g_lab, uhi, phi, np.maximum)
    extent = np.linalg.norm(phi[labels] - plo[labels], axis=1)
    small = (tri_counts < max(24, int(T * 0.002))) & (extent < diag * 0.03)
    small[np.argmax(tri_counts)] = False
    out["specks"] = int(small.sum())
    out["largest_island_share"] = round(float(tri_counts.max() / T), 4)
    out["largest_island_triangles"] = int(tri_counts.max())

    closed = out["boundary_edges"] == 0 and out["non_manifold_edges"] == 0
    out["watertight"] = bool(closed)
    volume = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)
    if closed:
        out["volume_m3"] = round(volume, 9)
        out["inside_out"] = volume < 0
    else:
        not_measured.append("volume (the mesh isn't closed)")

    # Self-intersections: triangles of the mesh that pass through each other.
    if deep and T <= 300_000:
        from mathutils.bvhtree import BVHTree
        t1 = time.time()
        merged_co = np.zeros((unique_v, 3))
        merged_co[inverse] = co
        mt = inverse[tris]
        ok = (mt[:, 0] != mt[:, 1]) & (mt[:, 1] != mt[:, 2]) & (mt[:, 0] != mt[:, 2])
        tree = BVHTree.FromPolygons(merged_co.tolist(), mt[ok].tolist(), all_triangles=True)
        pairs = tree.overlap(tree)
        hit = {i for p in pairs for i in p}
        out["self_intersecting_triangles"] = len(hit)
        out["self_intersection_seconds"] = round(time.time() - t1, 2)
    else:
        not_measured.append("self-intersections" + ("" if deep else " (quick check)")
                            + (" (over 300k triangles)" if T > 300_000 else ""))

    # UVs
    uv = g["uv"]
    has_uv = g["no_uv_objects"] == 0
    out["has_uvs"] = has_uv
    if not np.isnan(uv).all():
        tl = g["tri_loops"]
        ua, ub, uc = uv[tl[:, 0]], uv[tl[:, 1]], uv[tl[:, 2]]
        uarea = np.abs((ub[:, 0] - ua[:, 0]) * (uc[:, 1] - ua[:, 1]) - (ub[:, 1] - ua[:, 1]) * (uc[:, 0] - ua[:, 0]))
        valid = ~np.isnan(uarea)
        out["zero_area_uv_triangles"] = int(((uarea < 1e-12) & valid).sum())
        finite = uv[~np.isnan(uv).any(1)]
        out["uv_outside_0_1"] = round(float(((finite < -1e-4) | (finite > 1 + 1e-4)).any(1).mean()), 4) if len(finite) else 0
    out["faces_with_bad_material_index"] = g["bad_material_faces"]
    out.update(_textures(objs))
    out["not_measured"] = not_measured
    out["seconds"] = round(time.time() - t0, 2)
    return out


def speck_faces(obj):
    """Polygon indices of the specks in one mesh object, by exactly the rule measure() counts them:
    pieces (on merged vertices, so UV seams don't cut pieces apart) with few triangles AND a small
    size; never the largest piece. Used by the repair step so 'found' and 'removed' always agree."""
    me = obj.data
    v = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", v)
    co = v.reshape(-1, 3).astype(np.float64)
    e = np.empty(len(me.edges) * 2, np.int32)
    me.edges.foreach_get("vertices", e)
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", t)
    tp = np.empty(len(me.loop_triangles), np.int32)
    me.loop_triangles.foreach_get("polygon_index", tp)
    tris = t.reshape(-1, 3).astype(np.int64)
    T = len(tris)
    if T == 0:
        return []
    lo = co.min(0)
    diag = float(np.linalg.norm(co.max(0) - lo)) or 1.0
    q = np.round((co - lo) / (diag * 1e-5)).astype(np.int64)
    _, inverse = np.unique(_row_keys(q), return_inverse=True)
    inverse = inverse.reshape(-1)
    u = int(inverse.max()) + 1
    lab = _components(u, inverse[e.reshape(-1, 2).astype(np.int64)])
    tri_lab = lab[inverse[tris[:, 0]]]
    labels, counts = np.unique(tri_lab, return_counts=True)
    ulo = np.full((u, 3), np.inf)
    uhi = np.full((u, 3), -np.inf)
    g = _group(inverse)
    _scatter(g, co, ulo, np.minimum)
    _scatter(g, co, uhi, np.maximum)
    plo = np.full((u, 3), np.inf)
    phi = np.full((u, 3), -np.inf)
    g = _group(lab)
    _scatter(g, ulo, plo, np.minimum)
    _scatter(g, uhi, phi, np.maximum)
    extent = np.linalg.norm(phi[labels] - plo[labels], axis=1)
    small = (counts < max(24, int(T * 0.002))) & (extent < diag * 0.03)
    small[np.argmax(counts)] = False
    if not small.any():
        return []
    gone = np.isin(tri_lab, labels[small])
    return np.unique(tp[gone]).tolist()


# --------------------------------------------------------------------------- profiles

def _check(cid, label, value, ok, warn=None, unit="", want=""):
    if value is None:
        return {"id": cid, "label": label, "result": "unknown", "value": None, "want": want}
    result = "pass" if ok(value) else ("warn" if warn and warn(value) else "fail")
    return {"id": cid, "label": label, "result": result, "value": value, "unit": unit, "want": want}


def profiles(m):
    """Pass/warn/fail checks for three uses. Thresholds are listed with each check."""
    if not m.get("ok"):
        return {}
    tri, flipped_share = m["triangles"], m["flipped_edges"] / max(m["edges"], 1)
    si = m.get("self_intersecting_triangles")
    web = [
        _check("tris", "Triangles", tri, lambda v: v <= 150_000, lambda v: v <= 500_000, "", "≤ 150k (warn ≤ 500k)"),
        _check("tex", "Largest texture", m["texture_max_px"], lambda v: v <= 2048, lambda v: v <= 4096, "px", "≤ 2048 px"),
        _check("missing", "Missing textures", m["missing_texture_count"], lambda v: v == 0, None, "", "0"),
        _check("specks", "Floating specks", m["specks"], lambda v: v == 0, lambda v: True, "", "0"),
        _check("flipped", "Flipped faces", m["flipped_edges"], lambda v: flipped_share <= 0.001, lambda v: True, "edges", "≤ 0.1% of edges"),
        _check("material", "Has a material", m["materials"], lambda v: v > 0, lambda v: True, "", "≥ 1"),
    ]
    game = [
        _check("tris", "Triangles", tri, lambda v: v <= 50_000, lambda v: v <= 100_000, "", "≤ 50k (warn ≤ 100k)"),
        _check("uv", "UV map", m["has_uvs"], lambda v: v, None, "", "yes"),
        _check("loose", "Loose edges/points", m["loose_edges"] + m["loose_vertices"], lambda v: v == 0, lambda v: True, "", "0"),
        _check("nonmanifold", "Non-manifold edges", m["non_manifold_edges"], lambda v: v == 0, lambda v: True, "", "0"),
        _check("flipped", "Flipped faces", m["flipped_edges"], lambda v: v == 0, None, "edges", "0"),
        _check("degenerate", "Zero-area faces", m["degenerate_triangles"], lambda v: v == 0, lambda v: True, "", "0"),
        _check("tex", "Largest texture", m["texture_max_px"], lambda v: v <= 2048, lambda v: v <= 4096, "px", "≤ 2048 px"),
        _check("missing", "Missing textures", m["missing_texture_count"], lambda v: v == 0, None, "", "0"),
    ]
    printing = [
        _check("watertight", "Closed (watertight)", m["boundary_edges"], lambda v: v == 0, None, "open edges", "0 open edges"),
        _check("nonmanifold", "Non-manifold edges", m["non_manifold_edges"], lambda v: v == 0, None, "", "0"),
        _check("selfx", "Self-intersections", si, lambda v: v == 0, None, "triangles", "0"),
        _check("flipped", "Faces point outward", m["flipped_edges"] + (1 if m.get("inside_out") else 0), lambda v: v == 0, None, "", "0 flipped"),
        _check("islands", "One solid piece", m["islands"], lambda v: v == 1, lambda v: True, "pieces", "1"),
        _check("degenerate", "Zero-area faces", m["degenerate_triangles"], lambda v: v == 0, lambda v: True, "", "0"),
    ]

    def summary(checks):
        measured = [c for c in checks if c["result"] != "unknown"]
        p = sum(c["result"] == "pass" for c in measured)
        w = sum(c["result"] == "warn" for c in measured)
        f = sum(c["result"] == "fail" for c in measured)
        score = round(100 * (p + 0.5 * w) / len(measured)) if measured else None
        verdict = "ready" if f == 0 and w == 0 else ("usable" if f == 0 else "not ready")
        return {"checks": checks, "passed": p, "warnings": w, "failed": f, "unknown": len(checks) - len(measured),
                "score": score, "verdict": verdict}

    return {"web": summary(web), "game": summary(game), "print": summary(printing),
            "formula": "score = (passed + 0.5 × warnings) ÷ checks measured × 100"}
