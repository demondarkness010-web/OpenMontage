"""Check that this Blender can do Relief's work:  blender -b --factory-startup -noaudio -P diagnose.py -- out.json

Each check is written to out.json as soon as it finishes, so if Blender hangs or crashes the
server still sees how far it got. Every check really runs; nothing is assumed.
"""
import json
import os
import platform
import sys
import tempfile
import time

out_path = sys.argv[sys.argv.index("--") + 1]
result = {"checks": {}, "finished": False}


def save():
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1)
    for attempt in range(50):  # the server may be reading the file (Windows blocks the replace)
        try:
            os.replace(tmp, out_path)
            return
        except PermissionError:
            if attempt == 49:
                raise
            time.sleep(0.1)


def check(name, fn):
    t0 = time.time()
    try:
        value = fn()
        result["checks"][name] = {"ok": True, "value": value, "seconds": round(time.time() - t0, 2)}
    except Exception as e:  # noqa: BLE001
        result["checks"][name] = {"ok": False, "error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 2)}
    save()


import bpy  # noqa: E402

result["version"] = bpy.app.version_string
result["python"] = platform.python_version()
result["background"] = bpy.app.background
save()

work = tempfile.mkdtemp(prefix="relief-diag-", dir=os.path.dirname(os.path.abspath(out_path)))


def numpy_check():
    import numpy
    return numpy.__version__


def mesh_check():
    import bmesh
    for o in list(bpy.data.objects):  # the factory scene has its own cube, camera and light
        bpy.data.objects.remove(o, do_unlink=True)
    me = bpy.data.meshes.new("diag")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("diag", me)
    bpy.context.scene.collection.objects.link(obj)
    return {"vertices": len(me.vertices), "faces": len(me.polygons)}


def roundtrip_check():
    path = os.path.join(work, "cube.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
    size = os.path.getsize(path)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=path)
    tris = 0
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    if tris != 12:  # glTF stores triangles: 6 square faces come back as 12 triangles
        raise RuntimeError(f"re-imported cube has {tris} triangles, expected 12")
    return {"glb_bytes": size, "triangles_back": tris}


def workbench_check():
    s = bpy.context.scene
    s.render.engine = "BLENDER_WORKBENCH"
    s.render.resolution_x = s.render.resolution_y = 48
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.location = (3, -3, 2)
    cam.rotation_euler = (1.1, 0, 0.785)
    s.collection.objects.link(cam)
    s.camera = cam
    s.render.filepath = os.path.join(work, "workbench.png")
    bpy.ops.render.render(write_still=True)
    if not os.path.isfile(s.render.filepath):
        raise RuntimeError("no image written")
    return "renders"


def cycles_devices():
    prefs = bpy.context.preferences.addons["cycles"].preferences
    found = {}
    for kind in ("CUDA", "OPTIX", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            names = [d.name for d in prefs.devices if d.type == kind]
            if names:
                found[kind] = names
        except Exception:  # noqa: BLE001 - this kind isn't supported on this OS/build
            pass
    return found or "CPU only"


def gpu_info():
    import gpu
    return {"vendor": gpu.platform.vendor_get(), "renderer": gpu.platform.renderer_get()}


check("numpy", numpy_check)
check("mesh_edit", mesh_check)
check("gltf_round_trip", roundtrip_check)
check("workbench_render", workbench_check)
check("cycles_gpu", cycles_devices)
check("gpu_context", gpu_info)
result["finished"] = True
save()
for f in os.listdir(work):
    os.remove(os.path.join(work, f))
os.rmdir(work)
