# Relief tests

Run both before calling a change done. Commands are from the `pic3d/` folder.

## Blender side (inspector, repair, checkpoints, exports, job checks)

```bash
../.runtime/blender/blender-4.5.16-windows-x64/blender.exe -b --factory-startup -noaudio --python-exit-code 1 -P tests/blender_regression.py -- C:/temp/relief-tests
```

The suite builds small meshes, each with one known defect:
- a hole;
- a flipped face;
- an inside-out model;
- seam-split vertices;
- floating specks;
- a long thin part that must *not* count as a speck;
- self-intersecting boxes;
- a zero-area face;
- loose edges and points;
- a heavy mesh.

For each one it checks three things: the inspector finds the defect, Fix removes it, and the model keeps its size. It also checks that:
- a step that makes things worse is put back exactly, including one that crashes halfway;
- every export format survives a re-import with the same shape, size and materials;
- STL real-size export comes back in millimetres;
- a swapped export file fails validation;
- invalid jobs are refused before anything runs: unknown operations, extra parameters, out-of-range values, path escapes.

Add real models after the folder to also check that repair leaves them no worse and that the GLB re-imports:

```bash
... -P tests/blender_regression.py -- C:/temp/relief-tests generated/<id>.glb generated/<id>.glb
```

It prints `PASS`/`FAIL` per test and exits with code 1 if anything failed. The folder is deleted and re-created on every run.

## AI plan

```bash
node tests/planner.test.mjs
```

This uses fixed vision-AI analyses of objects that once got the wrong engine (wire cart, vinyl record, owl figurine, drawn character, courtyard scene) and checks the plan each one gets now.
