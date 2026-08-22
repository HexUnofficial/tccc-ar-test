# Source models

Authoring exports, kept out of `public/` so they are never deployed — the FBX
alone is 7.7 MB and the browser never reads it.

Regenerate the delivered models from here:

```bash
npm run dev                        # the FBX converter needs a browser
npm run model:tccc                 # FBX -> GLB -> simplified + Draco
npm run model:witch                # texture pass only
```

`TcccAirplane_FBX.fbx` references 27 external textures (`Wings_Diffuse_Tccc.png`,
`Fuselage_Main_Diffuse.png`, …) which are **not present**. Drop them in this
directory and re-run to get a textured aircraft; until then it converts, flies
and is correctly shaped, but renders untextured.
