# Source models

Authoring exports, kept out of `public/` so they are never deployed — the FBX
alone is 7.7 MB and the browser never reads it.

Regenerate the delivered models from here:

```bash
npm run dev                        # the FBX converter needs a browser
npm run model:tccc                 # FBX -> GLB -> simplified + Draco
npm run model:witch                # texture pass only
```

## Which file is live

`npm run model:tccc` reads `TCCCAirplane_glb-optimized_V5.glb`. The earlier
exports are kept because they are the only copies: V4 and before carried the
animation as one clip per object — 223 of them, all but a single propeller clip
static — while V5 delivers one `FlightDetails_Loop` with 8 channels. The loader
plays every clip it finds, so both work, but V5 is the one with the animation
worth watching.

Textures must not come out as WebP. iOS Safari fails to decode
`EXT_texture_webp` and the aircraft renders white, so the optimiser re-encodes
to PNG; if a future export arrives as WebP and the pass is skipped, that is the
bug it will look like.

`TcccAirplane_FBX.fbx` references 27 external textures (`Wings_Diffuse_Tccc.png`,
`Fuselage_Main_Diffuse.png`, …) which are **not present**. Drop them in this
directory and re-run to get a textured aircraft; until then it converts, flies
and is correctly shaped, but renders untextured.
