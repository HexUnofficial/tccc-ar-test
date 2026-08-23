# tccc-ar-test

Geo-anchored AR for the mobile web. Points a phone's camera at the world, works
out where you are and which way you're facing, and holds a 3D model at a fixed
real-world coordinate — tracked by SLAM, so the model stays put while you move
rather than being dragged around by your own sensors. Runs in mobile Safari and
Android Chrome: no app, no app store, no WebXR requirement.

Built on the **[8th Wall engine](https://8thwall.org/docs)** (XR8) and three.js.
Since 8th Wall's hosted platform was retired in February 2026 the engine ships as
[an npm package](https://github.com/8thwall/8thwall) rather than a keyed CDN
script — there is no app key and no domain allowlist, but the engine binary is
proprietary and its licence carries an attribution obligation. See
[Getting it running](#getting-it-running).

The previous engine, [LocAR.js](https://github.com/AR-js-org/locar.js), is still
in the tree and reachable with `?engine=locar` — see
[Why the port](#why-the-port-world-position-vs-camera-position).

## Why the port: world position vs camera position

The complaint that prompted this branch:

> We need to find a way to separate between world position and camera position.
> If the plane is unable to fly past us without it being knocked off course by
> the camera movement, that to me feels like a showstopper.

It was a showstopper, and it was not a bug. It was the architecture.

**The old engine had one frame of reference and wrote both things into it.** The
camera's rotation came from the compass, its position came from GPS, and the
aircraft's lat/lon was converted into that same space. So every error in either
sensor arrived as *world* motion:

| what happened | what you saw |
| --- | --- |
| compass lag while panning | the scene slid, then settled — "it follows the camera" |
| a GPS fix landing 8 m off | the ground shoved sideways while you stood still |
| the aircraft flying past you | indistinguishable from the aircraft being pushed off course |

That last row is the showstopper, and no filter fixes it, because the
information needed to tell the two cases apart was never in the signals. GPS
cannot see a two-metre sidestep and a compass cannot tell "I turned" from "the
world turned". The record of trying is still in
[src/config.js](src/config.js) — a 1€ filter, a feed-latency estimator, three
tables of measurements — and all of it was nulling one error against another.

**8th Wall changes what is available.** XR8's world tracking derives a 6DoF pose
from the camera frames themselves, in a local world frame that stays put. That
gives two genuinely independent quantities for the first time:

```
camera pose    owned by SLAM, written every frame, never touched by us
world anchor   owned by src/xr/georef.js, in metres, in that same frame
```

The aircraft's position is computed once from its lat/lon and then lives in the
world frame as a plain number. Panning cannot move it, because panning only
changes the camera. Walking cannot move it either — walking moves the camera
through a world that is standing still, which is what parallax *is*. **The
aircraft can fly past you because its path is expressed in a frame you are not
part of.**

[src/xr/georef.js](src/xr/georef.js) is the whole of it: a translation (which
world point a given lat/lon is) and a yaw (which way is north). Six numbers,
resolved on the first good GPS fix and then left alone.

### The claim is a test, not a feeling

```bash
npm run test:parallax
```

Runs against `?sim=1`, so it needs no camera and no phone:

| check | result |
| --- | --- |
| a full pan, 72 steps, plus a pitch sweep | aircraft world position moves **0.0000 mm** |
| a 10 m sidestep | world position **0.0000 mm**, screen position **0.138 NDC** |
| one lap with the camera thrown around vs. left still | trajectories differ by **0.0000 mm** |
| 15 m of GPS jitter, `geolock=once` | anchor moves **0.0000 mm** |
| the same jitter with `geolock=follow` | anchor moves **14.2 m** — so the stillness above is the georeference holding, not the fixes failing to arrive |

`npm run test:georef` checks the placement maths that the above says nothing
about — the yaw convention, round trips, and the sign of the correction. Its
last case starts a georeference **40° wrong**, as an uncalibrated Android
magnetometer would, walks 60 m, and recovers the true yaw to **0.00°**. See
[walk alignment](#if-you-do-not-trust-the-compass).

### What the port deleted

Roughly 300 lines, and it matters that nobody re-adds them:

| gone | why |
| --- | --- |
| rotation filters, `?smoothrot=`, `?beta=`, `?fcmin=`, `?filter=` | smoothed a compass the render no longer reads |
| `?feedmatch=`, `?feedlag=`, the aim-history ring | lined a live sensor up against a delayed video frame; SLAM derives the pose *from* that frame, so they cannot disagree |
| `?lens=`, `?vfov=`, `holdFieldOfView` | XR8 supplies real camera intrinsics; the angles-to-pixels scale is measured, not nulled by eye |
| `?avg=`, `?smooth=`, `?mindist=` | hid the fact that GPS was steering the camera |
| [src/projection.js](src/projection.js) | undid LocAR's Mercator; georef's tangent plane is metric to begin with |

Those query parameters still work under `?engine=locar`. Under the default
engine they are ignored, which is deliberate — they describe a machine that is
no longer there.

## Getting it running

The engine is an npm dependency, not a hosted script:

```bash
npm install
npm run dev
```

`npm run xr8:sync` runs automatically before `dev` and `build`. It stages
`@8thwall/engine-binary` and `@8thwall/xrextras` into `public/external/`, where
Vite serves them in development and copies them verbatim into `dist` on build.
[index.html](index.html) loads them with plain script tags.

They deliberately do not go through the bundler. `xr.js` fetches its SLAM chunks
at runtime by path relative to itself, so a hashed bundle breaks them — and the
engine licence permits distribution only in the original form, which settles it
either way. `public/external/` is gitignored: it is generated from
`package-lock.json` like anything else in `node_modules`.

**There is no app key and no domain allowlist.** If you have read older 8th Wall
documentation, ignore everything it says about `appKey`, authorised domains and
the Cloud Editor — see below.

### What happened to the hosted platform

8th Wall's hosted platform was **retired on 28 February 2026**: logins, the cloud
editor and the web-based Studio are gone, and experiences published on it run
only until 28 February 2027. 8th Wall is now community-driven under Niantic
Spatial, with the engine distributed on npm.

For this project that is a simplification. Gone with it: the `VITE_XR8_APP_KEY`
environment variable, the subdomain-specific authorised-domains list, deploy
previews failing on an unauthorised origin, whitelisting a LAN IP to test on a
phone, and the paid plan that self-hosting used to require.

What it costs is a **2.1 MB gzipped** first load that used to come off 8th Wall's
CDN and now comes off ours — `xr.js` at 0.33 MB and `xr-slam.js` at 1.78 MB,
cached for a week by [netlify.toml](netlify.toml). The aircraft downloads in
parallel with it. `dist` grows to about 30 MB, most of which is face and
semantics models that a visitor never requests; they ship because the licence
does not permit us to prune the distribution.

There is also an **8th Wall Desktop App** (macOS public beta) — that is the Studio
editor, and this project does not use it. We integrate the engine into our own
Vite build instead.

### Licence, and what it obliges us to do

Two different licences, and the distinction matters for a client deployment:

- The **open-source 8th Wall toolset** is MIT.
- The **engine binary we actually ship** — SLAM, absolute scale, the camera
  pipeline — is not. It is proprietary, under the
  [XR Engine License Agreement](https://github.com/8thwall/engine/blob/main/LICENSE),
  a limited, revocable, non-transferable licence.

Commercial use of the kind this project is: **permitted**. Niantic Spatial's
[Permitted Use FAQ](https://8thwall.org/docs/migration/faq) is explicit that
agencies may use the engine for branded client work "provided the engine is one
component of a broader creative or marketing deliverable" — the principle being
that you may sell the experience but not the engine. A branded AR activation is
the example they give. What is forbidden is reselling the engine, building a
competing product, or reverse-engineering it.

**Attribution is mandatory**, and it is a licence term rather than a courtesy.
Clause 1.3 requires the deployed experience to identify Niantic Spatial as the
engine's creator, carry a copyright notice, refer to the licence, and note the
disclaimer of warranties. That is the `.gate-credit` line on the start screen,
and `npm run test:xr8` asserts it is present and visible — a gate redesign could
otherwise drop it silently. The packages' own `LICENSE` files are copied into
`dist` for the same reason.

Two things to take to whoever signs this off: the licence is **revocable** and
the platform is now **community-maintained rather than vendor-supported**, so
there is no support contract behind the tracker. Niantic Spatial ask that
enterprise arrangements go to `support@nianticspatial.com`.

## Quick start

```bash
npm install
npm run dev
```

Open the **https** URL it prints. On a laptop, add `?sim=1`:

```
https://localhost:5173/?sim=1
```

That skips XR8 entirely, uses your laptop webcam for the
passthrough feed, and gives you **drag to look around**, **WASD to walk** and
**Q/E for height**. Hold shift to move faster.

The simulator now models the thing 8th Wall actually provides: six degrees of
freedom in a world frame that stays put. The camera is translated directly in
metres and GPS is synthesised *from* where it ends up, which is the same
direction of causation as the device. The old simulator could not do that — it
moved you by feeding fake GPS in, because GPS was the only position input the
engine had, so the one behaviour you most needed to check (walk past something,
watch it hold still) was the one it could not reproduce.

`?simnoise=15` adds 15 m of random error to each synthetic fix, which is how to
watch `geolock` do its job. `?engine=locar` runs the old engine for comparison.

## Testing on an actual phone

GPS AR only really tells you the truth outdoors, on the device, in the location.

**Same Wi-Fi (quickest).** `npm run dev` prints a `Network:` URL. Open it on the
phone. The dev certificate is self-signed, so you'll get a warning — accept it.
Android Chrome is fine with this; iOS Safari is sometimes stubborn about
granting camera access on an untrusted certificate.

**Tunnel (reliable, and what to use for iOS).** Gets you a real trusted
certificate, and works off your network:

```bash
npm run dev
npx cloudflared tunnel --url https://localhost:5173 --no-tls-verify
```

Open the `trycloudflare.com` URL on the phone.

Once it loads: tap **Start AR**, grant camera, location and motion access, then
walk outside and turn around until the white arrow disappears. Tap the **i**
button for live telemetry — your fix, accuracy, heading, and the distance and
bearing to the model.

### Getting a good test

- **Go outside.** Indoor GPS is 30–100 m out and the compass is wrecked by
  steel and speakers. Nothing will line up.
- **Wave a figure-eight** to settle the magnetometer if the heading looks wrong.
- **Watch the accuracy reading.** Below ±10 m is good, above ±25 m the model
  will visibly wander.
- **Start with `?mode=relative`** so the model appears near you wherever you
  are, then switch to the real coordinates.

## Defining the location

Edit [src/location.js](src/location.js). It's currently set to **174 St John
Street, London EC1V 4DE**:

```js
export const INSTALLATION = {
  label: '174 St John Street, London',
  lat: 51.524333,     // 51 deg 31' 27.6" N
  lon: -0.102722,     //  0 deg 06' 09.8" W
  elevation: 0,       // metres above your feet
};

export const DEFAULT_MODE = 'fixed';   // 'relative' while testing
```

To get the numbers: open Google Maps, right-click the exact spot, and click the
`lat, lon` pair at the top of the menu to copy it. Decimal degrees, north and
east positive — **west of Greenwich is negative**, which is most of the UK. Six
decimals is about 10 cm, finer than GPS can resolve, so don't agonise.

Degrees/minutes/seconds convert as `deg + min/60 + sec/3600`, then negate for
west or south.

Set `DEFAULT_MODE` to `'fixed'` when the coordinates are real. Leave it at
`'relative'` and the model is placed a set distance from wherever you're
standing, which is what makes it testable anywhere.

## Placing it on the map

```bash
npm run dev          # then open /setup.html
```

Two things have to be decided on a map and can't sensibly be typed: the exact
point on the water, and the bearing of the river through it. A postcode gives
you neither — it's a delivery *area*, and its centroid can be tens of metres out
and is never on a river.

So the two pins are the **two ends of the run**: the aircraft beats back and
forth between them. Everything the AR page needs falls out of that pair — the
anchor is their midpoint, the heading is the bearing from A to B, and the leg
length is the distance between them. The page draws the **actual circuit** the
aircraft will fly —
sampled from the same `createFlightPath` the AR page uses, not an approximation
— so you can see at a glance whether it stays over the water or banks over the
embankment. Sliders for leg length, turn radius, altitude and speed update it
live.

Sliders set the run length, turn radius, altitude, speed and **aircraft size**,
and a *watched from* slider predicts how big it will be on screen — including
whether the banner lettering will be legible at that distance. That question is
much cheaper to answer here than at the riverbank.

**Use my current location** centres the run on where you are, so you needn't
look your own coordinates up. On a laptop that is network positioning and can be
a kilometre out, so treat it as a way to get the map roughly right, not to set a
final anchor; the readout shows the accuracy.

Then, without copying anything:

- **Preview here** opens the AR page on this machine with simulated GPS, standing
  off to the side of the run so you can see the whole sweep. Drag to look, WASD
  to walk. This is the one that works on a laptop.
- **Open for real** opens the same URL using the device's actual location and
  camera — only meaningful on a phone at the site.
- **The QR** encodes that same real URL, for scanning with a phone.

Note the QR is useless if you opened the picker at `localhost`, because on a
phone that resolves to the phone. Open it via the `Network:` address that
`npm run dev` prints instead; the page says so when it detects this.

There is also a snippet to paste into [src/location.js](src/location.js) once
you're happy, which is what makes the placement permanent.

**It is a development tool and is never deployed.** `npm run build` leaves
`setup.html` out of the bundle entirely; `INCLUDE_SETUP=1 npm run build` opts
back in if you ever want it somewhere private. `npm test` asserts the exclusion,
because "we accidentally shipped the page that lets anyone move the aircraft" is
not a thing you want to discover later.

### Locking the real thing down

Every setting here is overridable from the query string, which is what makes it
tunable in the field — and also means anyone can drag the aircraft somewhere
else by editing the URL. Set `LOCKED = true` in
[src/location.js](src/location.js) before going live: the parameters that decide
*where* the experience is (`lat`, `lon`, `mode`, `heading`, `elev`) are then
ignored, while the harmless presentation ones still work.

## Tuning from the phone

Every setting has a query parameter, so you can retune in the field from the
address bar instead of redeploying.

| Parameter | Default | Purpose |
|---|---|---|
| `mode` | `relative` | `fixed` pins to `INSTALLATION`, `relative` places it near you |
| `lat`, `lon` | from `location.js` | Override the site coordinates |
| `distance` | `20` | Relative mode: metres away |
| `bearing` | `0` | Relative mode: degrees from true north |
| `elev` | `0` | Metres above your feet |
| `model` | `airplane` | `airplane` or `witch` |
| `size` | `60` | Overall length in metres — aircraft, tow line and banner together |
| `path` | `racetrack` | Flight circuit: `racetrack`, `circle`, `eight` |
| `heading` | from `location.js` | `across`, `along`, or a compass bearing for the line |
| `length` | `250` | Straight leg, in metres, or `fit` to size it to the frame |
| `turn` | `40` | Turn radius at each end — also half the gap between legs |
| `speed` | `20` | Airspeed in m/s (20 ≈ 72 km/h) |
| `alt` | `50` | Flight altitude above the anchor, in metres |
| `bank` | `45` | Maximum roll into a turn, in degrees |
| `rolltime` | `0.8` | Seconds to roll into a bank. `0` snaps |
| `radius`, `period` | `30`, `16` | Only used by `circle` and `eight` |
| `yaw` | `0` | Degrees of extra rotation, if the model faces the wrong way |
| `faceuser` | `1` | `0` to stop it turning to face you |
| `minacc` | `100` | Ignore GPS fixes worse than this many metres |
| `farwarn` | `200` | Metres from the anchor beyond which the HUD warns you |
| `sim` | `0` | `1` for desktop simulation |
| `ui` | `minimal` | `minimal` (arrow + warnings), `none` (arrow only), `debug` (everything) |
| `debug` | — | Shorthand for `?ui=debug` |
| `fullscreen` | `1` | `0` to stay windowed |

### The 8th Wall engine

| Parameter | Default | Purpose |
|---|---|---|
| `yaw0` | — | State the world frame's true bearing outright; skips the compass |
| `geolock` | `once` | `once`, `slow` or `follow` — what later GPS fixes may do |
| `corrate` | `0.5` | Metres per second of positional correction under `slow` |
| `alignwalk` | `0` | `1` to solve the yaw from GPS-vs-SLAM displacement as you walk |
| `walkbase` | `8` | Metres of travel before a walk-alignment sample counts |
| `headingsamples` | `20` | Compass samples averaged before the world is placed |
| `worldtracking` | `1` | `0` for rotation only, no SLAM — the escape hatch |
| `scale` | `absolute` | `responsive` to scale content to the screen instead |
| `near`, `far` | `0.01`, `8000` | Depth range, in metres. `far` has to clear the circuit |
| `standoff` | `300` | Simulator: metres from the anchor to stand |
| `simyaw` | `0` | Simulator: yaw to give the fake world frame |
| `simnoise` | `0` | Simulator: metres of random error per synthetic fix |
| `engine` | `8thwall` | `locar` for the old engine |

### Retired with the port

These do nothing under the default engine, and still work under
`?engine=locar`: `mindist`, `avg`, `smooth`, `smoothrot`, `filter`, `fcmin`,
`beta`, `feedmatch`, `feedlag`, `lens`, `vfov`. See
[What the port deleted](#what-the-port-deleted).

Example: `?mode=relative&distance=10&bearing=270&yaw0=114.5`

## The model

Three are bundled, chosen with `?model=`. [src/models.js](src/models.js) holds
the presets; the default is `tccc`, the banner-towing aircraft.

**Keep GLB, not FBX.** glTF/GLB is the native format of the web — three.js loads
it directly, it carries PBR materials, skinning and animation in one binary
file, and it's an open Khronos standard. FBX is a proprietary interchange
format; the three.js FBX loader is heavier, slower, and supports fewer material
features. If you're handed an FBX, convert it rather than shipping it.

Both models are auto-scaled to a real-world size, so you needn't care what units
they were authored in. The aircraft is normalised along its **longest axis**
(you think about an aeroplane in wingspan, not height); the witch is normalised
by **height**.

### The flight circuit

The aircraft GLB's own clip is a gentle vertical bob with a few degrees of
wobble — good secondary motion, but it never leaves the spot. So the clip keeps
playing for life, and [src/flight.js](src/flight.js) supplies the travel on top:
a **racetrack**, a straight leg with a 180 at each end.

A racetrack rather than a circle or a figure-eight because those visibly double
back through their own middle. A racetrack reads as an aircraft beating up and
down a line — which is the point, because that line is meant to be a river.

The path is parametrised by distance travelled, not by angle, so speed is
constant everywhere and set in m/s. Bank angle comes from the path's actual
curvature rather than keyframes, so it stays correct when you change the radius
or the speed, and it's eased over `rolltime` because a real aircraft takes a
moment to roll and the curvature jumps the instant a straight meets a turn.

**Pointing it down the river.** `FLIGHT_HEADING` in
[src/location.js](src/location.js) takes a true compass bearing — measure it by
dropping two Google Maps pins along the stretch you want and taking the bearing
between them. The two alternatives, `across` and `along`, resolve against your
line of sight instead and are for testing away from the site: `across` keeps the
aircraft sweeping left and right in front of you wherever you stand.

The circuit is centred on the anchor, so put the anchor **on the water**, set
the heading to the river's bearing, and keep `turn` inside half the river's
width or the aircraft will bank over the bank.

**Distance is the thing to get right.** Defaults are a 250 m leg at 50 m
altitude, one lap every 38 seconds. A 14 m aircraft then looks like this:

| Watching from | Range | On screen | Elevation | Sweeps across |
|---|---|---|---|---|
| 50 m | 71 m | 184 px | 45° | 136° |
| 150 m | 158 m | 83 px | 18° | 80° |
| 300 m | 304 m | 43 px | 9° | 45° |
| 600 m | 602 m | 22 px | 5° | 22° |

At a few hundred metres it is genuinely small — because a real aircraft that far
away *is* small, and inflating it is the fastest way to make it stop looking
real. It leaves the frame at the ends of the circuit, which is intended: people
pan to follow it. The live **Subject** row in `?debug=1` shows the current range
and pixel size, so you can judge this on site rather than guessing.

The direction arrow tracks the aircraft itself, not the anchor — on this circuit
they are up to 165 m apart, and an anchor-locked arrow points at empty sky.

Two things worth knowing if you swap in a different aircraft: the nose must be
brought onto the direction of travel with `noseOffset` in the preset (this one
is authored nose-along-−X, so it needs −90°), and the flight path owns
horizontal motion only — vertical is deliberately left to the clip.

### The TCCC aircraft, and why it is a GLB

The source is `source-models/TcccAirplane_FBX.fbx`. We convert rather than load
FBX at runtime, and the numbers are the argument:

| | FBX at runtime | Converted GLB |
|---|---|---|
| Payload | **7.7 MB**, before textures | **0.6 MB**, textures included |
| Textures | 27 loose PNGs, 27 requests | packed in, WebP, one file |
| Loader | 51 KB gzipped | 30 KB gzipped |
| Parse | JavaScript | Draco WASM |

Same 289k-triangle mesh either way. FBX has no compression scheme at all; Draco
plus simplification is what takes 27 MB to 0.6 MB, and the 10 MB budget is not
survivable otherwise. FBX is an *interchange* format for moving between 3D
tools; glTF is a *delivery* format for shipping to a browser.

```bash
npm run dev        # the converter needs a browser: three's FBXLoader wants a DOM
npm run model:tccc # FBX -> GLB -> welded, simplified to 25%, Draco
```

The delivered model comes from `source-models/TcccAirplane-optimized.glb`, a
glTF-Transform export carrying its textures as 16 images. The FBX route is
kept for when only an FBX is available, but FBX carries no textures unless
exported with "Embed Media" on: ours has 156 texture slots, 77 file paths and
**zero `Content` nodes**, so it converts and flies but renders untextured.

That export's textures arrived as WebP behind a *required* `EXT_texture_webp`,
which is fine on desktop Chromium but rendered the whole aircraft flat black on
an iPhone in the field — GLTFLoader's `ImageBitmapLoader` path is the prime
suspect for why the decode silently fails there. `npm run model:tccc`
re-encodes them to PNG first (`gltf-transform png ... --formats webp`), which
has no decoder to fail on any platform, before the geometry pass below. That
costs size — PNG doesn't compress photographic textures anywhere near as well —
but a one-time load before a client demo is the wrong place to economise.

That export also arrived with **223 animation clips**, one per object, all
41.7 seconds long: a Blender artifact where one action was applied to
everything. Only the propeller moves, so the geometry pass drops channels
whose values never change — 668 constant channels and 222 empty clips,
leaving `Propeller|PropellerAction.001`. That is 669 animation tracks a frame
down to one, which matters on a phone.

**A trap worth recording.** `prune()` strips `TEXCOORD_0` from the 26
primitives whose materials have no texture. That is correct and harmless, but
under inspection it looks exactly like "the compression ate the textures" —
221 primitives with UVs becomes 195. It is not: the same 195 meshes render
textured either way.

### Shrinking a model

Two passes, deliberately separate processes:

- **[tools/optimize-model.mjs](tools/optimize-model.mjs)** — textures: resize to
  1024px, re-encode as WebP. The witch went 8.2 MB → 1.2 MB.
- **[tools/optimize-geometry.mjs](tools/optimize-geometry.mjs)** — geometry:
  drop constant animation channels, weld, simplify to 25%, Draco. Run on the
  PNG-re-encoded export, the TCCC aircraft goes ~15 MB → ~7 MB and 289k
  triangles → ~95k, textures intact. Exact numbers move with each new export
  from the 3D team; `npm run model:tccc` prints the current ones.

They cannot share a process: importing `@gltf-transform/functions` leaves sharp
unable to encode, out of libvips. Tune with `MAX_TEXTURE=512 WEBP_QUALITY=75`
and `SIMPLIFY_RATIO=0.15`.

## Automated tests

```bash
npm test
```

Builds, serves, and drives the real page in headless Chromium with a synthetic
camera and a mocked GPS fix. It checks that the model downloads, the camera
stream starts, the GPS fix lands the model at the right distance and bearing, the
model actually rasterises at the correct physical size, and the direction arrow
appears and hides when it should.

**Three suites cover the port itself, and they run first**, because a failure in
any of them makes the visual tests meaningless:

- **[tools/georef-test.mjs](tools/georef-test.mjs)** — the placement maths, with
  no browser at all. The yaw convention (including the `yaw 90` case that catches
  a sign flip, which on site would put the aircraft in the wrong quadrant of an
  empty sky with nothing to line it up against), round trips across 105
  yaw/bearing/range combinations, the sign of a `geolock` correction, and walk
  alignment recovering a 40° compass error to 0.00°. It runs before the build and
  aborts everything if it fails.
- **[tools/parallax-test.mjs](tools/parallax-test.mjs)** — the showstopper, as a
  test. Panning, walking and GPS jitter must not move the aircraft; walking must
  still change where it appears. See
  [The claim is a test](#the-claim-is-a-test-not-a-feeling) for the numbers. The
  fifth case deliberately makes the world move, with `geolock=follow`, so that
  the stillness in the fourth is evidence of the georeference holding rather than
  of the fixes never arriving — a test that only ever asserts "nothing changed"
  passes just as well when nothing is running.
- **[tools/xr8-test.mjs](tools/xr8-test.mjs)** — the two parts of the 8th Wall
  path reachable without a camera: that widening the depth range keeps a 2.5 km
  circuit inside the frustum without disturbing the focal terms, that the engine
  is served from our own origin and never from the retired hosted platform, that
  a deploy which skipped `xr8:sync` says so on the gate instead of white-screening
  or spinning forever, and that the licence attribution is present and visible.

Everything below this line predates the port and drives the old engine via
`?engine=locar`. It is kept because that engine is kept for on-site comparison;
several of them measure machinery the 8th Wall build does not have.

The two movement tests are the ones that matter most for feel, and each catches
something the static placements can't:

- **`tools/walk-test.mjs`** holds one session open and moves the GPS fix
  underneath it in 2 m steps, asserting she gets visibly bigger at every step.
  Placement can be perfectly correct while movement feels dead.
- **`tools/motion-test.mjs`** walks a simulated pedestrian past a 1 Hz GPS feed
  and samples the rendered camera every frame, asserting the motion is
  *continuous* rather than lurching. Its headline number is speed variability,
  where 0 is perfectly constant motion:

  | | raw GPS (`smooth=0`) | default (`smooth=1.2`) |
  |---|---|---|
  | speed variability | 7.80 | 0.08 |
  | frames frozen between fixes | 98.3% | 0.5% |
  | lag behind the fix | 0 m | 0.8 m |

  Updates arriving promptly and updates *looking* smooth are different
  properties, and only this test measures the second one.
- **`tools/banner-test.mjs`** checks the status banner reflects actual state and
  recovers from a GPS dropout, rather than stranding a stale error on screen.
- **`tools/drift-test.mjs`** feeds realistic GPS noise to a *stationary* viewer
  and asserts the scene holds reasonably still, then feeds a real 60 m walk and
  asserts it still follows. Its threshold is the theoretical one — averaging n
  fixes cuts random error by root n, so 6 m of wander through a 3-fix window
  should land near 3.5 m. Content sliding around while you stand still is
  indistinguishable from the AR being broken, and no amount of correct placement
  makes up for it.
- **`tools/setup-test.mjs`** drives the map picker, takes the URL it emits,
  opens it, and checks the aircraft really is anchored and aimed where the map
  said. Checking the picker's own readout would prove nothing about the handoff.
- **`tools/flight-test.mjs`** scrubs a full circuit and asserts the aircraft
  actually translates, keeps its nose within 0.1° of the direction of travel,
  banks both ways, and leaves vertical motion to the clip — which is still
  running underneath. It also checks the path never doubles back through
  itself, and that the direction arrow follows the aircraft rather than the
  anchor. "Flying sideways", "sitting still" and "pointing at empty sky" all
  look like nothing much on a phone screen at 300 m.

The GPS placement tests run against `?model=witch` deliberately: they measure a
stationary subject's apparent size, which the aircraft's own motion would
confound.

It also confirms the camera feed is playing and that nothing opaque is stacked
in front of it — the passthrough video sits behind the canvas at `z-index: -100`,
and it is very easy to hide it behind a background colour by accident.

For a picture rather than a pass/fail:

```bash
npm run build && npx vite preview --port 4173 &
npm run screenshot          # -> .tmp/shot-ar.png
```

That one uses the full Chromium build, which composites the (synthetic) camera
feed into the image; the headless shell used by `npm test` does not, so frames
captured there always look black.

One caveat on the suite itself. It used to leak a preview server on every run —
`spawn` goes through a shell on Windows, so `server.kill()` killed the shell and
left `vite` holding port 4173 — and the next run's `fetch` would answer from that
stale server, silently testing a previous build. That produced exactly what it
looked like: intermittent failures, a different scenario each time, all of them
passing when run alone. `run-tests.mjs` now refuses to start if anything already
holds the port, and kills the process tree rather than the shell. If you see that
refusal, something really is still running; the message says how to clear it.

What none of it can tell you, and this list got longer with the port: **XR8's
actual tracking quality**, whether absolute scale puts the ground where it should
be, whether tracking holds when the phone tips up past the skyline at open sky,
compass accuracy, magnetometer drift, real GPS jitter, sunlight legibility, or
thermal throttling. Headless Chromium has no camera to track against, so
everything about the pose itself needs a phone and a pavement.

The one thing the suite *can* now prove without a device is the thing that was
in dispute: that the world and the camera are separable. That is not a matter of
opinion any more.

## Troubleshooting

**"The aircraft is tiny."** That is what 14 m at 300 m looks like. Check the
Subject row in `?debug=1` for the real numbers before reaching for `?size=`;
the honest fixes are a closer anchor or a lower `?alt=`.

**"The distance isn't closing" / "she never appears."** You're almost certainly
not at the site. `DEFAULT_MODE` is `'fixed'`, so the model is pinned to St John
Street — from three miles away, walking 20 m is a real 20 m of progress and
completely imperceptible, and the model is a sub-pixel speck. The HUD now says
so explicitly past 200 m. Add `?mode=relative` to test where you are.

**"She's the wrong size."** Adjust `?height=` — it's her real-world height in
metres, and everything else scales from it.

**"She's facing away from me."** `?yaw=180`, or `?faceuser=0` if she shouldn't
turn to follow you at all.

**"It's all drifting / swimming."** Check the Accuracy reading in the HUD. Above
±25 m the content will visibly wander and there is nothing the code can do about
it. Get away from buildings and wait for the fix to tighten.

**"The camera is black."** The passthrough feed is a `<video>` behind the canvas
at `z-index: -100`. Anything opaque painted over it — a background colour on
`<body>`, for instance — hides it while the model still renders. `npm test`
guards against this specific mistake.

## Going frameless

By default the overlay is just the direction arrow, plus a banner when
something is actually wrong (no GPS, wrong postcode). `?ui=none` drops even
that; `?debug=1` brings back the full telemetry panel.

Removing the *browser's* chrome is a platform question, not a code one:

| | How | Result |
|---|---|---|
| **Android Chrome** | Fullscreen API, requested on the Start AR tap | Fully frameless, automatic |
| **iOS Safari** | No Fullscreen API on iPhone, at all | Chrome stays |
| **iOS, installed** | Share → **Add to Home Screen**, launch from the icon | Fully frameless |

There is no way for a web page to hide Safari's chrome on an iPhone. The
manifest and `apple-mobile-web-app-capable` are already set, so installing to
the Home Screen launches with no chrome — that is the whole of the iOS story,
and it is worth telling testers explicitly.

### If frameless matters more than GPS

`TCCCAR_WebServer` in this workspace achieves a frameless experience a
completely different way: `<model-viewer>` with
`ar-modes="webxr scene-viewer quick-look"` hands the model to the operating
system's own AR viewer — **AR Quick Look** on iOS, **Scene Viewer** on Android.
Those open as native full-screen overlays, so there is no browser chrome
anywhere.

The catch is that they are *surface* trackers. They find a floor or a table in
front of you and put the model on it. Neither accepts a coordinate, so **GPS
anchoring is not possible in that mode** — you cannot ask Quick Look to place
something at 51.524306, -0.101917. It's a genuine either/or:

| | Native handoff (model-viewer) | In-page (this project) |
|---|---|---|
| Browser chrome | None, anywhere | None on Android; Home Screen on iOS |
| Anchored to | A surface in front of you | A real-world coordinate |
| GPS | Not available | Yes |
| Needs a USDZ as well as a GLB | Yes, for iOS | No |

If the brief is "she stands at 174 St John Street", this project is the only one
of the two that can do it.

## Deploying

Deployed to **Netlify** from `main`. [netlify.toml](netlify.toml) pins the build
so it is reproducible from the repo rather than from the dashboard:

```toml
command = "npm run build"     # note: no INCLUDE_SETUP, so the picker is omitted
publish = "dist"
NODE_VERSION = "22"           # Vite 8 needs a modern Node
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
```

That last one matters: Playwright is a devDependency used only by the tests, and
its install step would otherwise pull ~150 MB of browsers into every deploy.

**Nothing extra to configure.** There is no app key and no domain allowlist, so
deploy previews work and there are no environment variables to forget. The one
thing a deploy must do is run `npm run xr8:sync`, and `prebuild` does that
automatically — a build that somehow skipped it produces a page that loads, shows
the gate, and then names the missing engine, which `npm run test:xr8` covers.

Two hard requirements, both of which Netlify satisfies by default:

- **HTTPS.** Camera, geolocation and motion sensors are all refused on plain
  HTTP. There is no way around this.
- **A correct MIME type for `.glb`.** Set explicitly in `netlify.toml` along
  with a long cache lifetime, since the models are content-hashed by nothing and
  change rarely.

The build is about 210 KB of gzipped JavaScript plus a 205 KB aircraft — small
enough to load over mobile data at the riverbank, which is the only test that
counts.

## Placing the world without trusting the compass

The georeference needs one thing the maths cannot derive: which way XR8's world
frame is pointing. There are three ways to supply it, in increasing order of how
much you should trust them.

### The compass (default)

Read once, at the moment of the first good GPS fix, as a circular mean of ~20
samples rather than whichever event landed on the frame the user tapped. Then
the listener is **stopped** and never consulted again — so compass *drift*,
which was the old engine's worst enemy, cannot affect anything.

Samples where the lens is within 20° of vertical are discarded: a phone pointed
at the sky has no meaningful heading, and letting those into the mean is how you
get a confident wrong answer.

### Stated outright (what to deploy)

```
?yaw0=114.5
```

Skips the compass entirely. This is the setup ritual for a real installation:
stand on the mark, point the phone down the run, tap. The compass is the weakest
sensor in the stack — iOS gives true north, Android can be tens of degrees out
until it has been waved in a figure of eight — and this is the way to not depend
on it. Note that `yaw0` is a *placement* parameter, so `LOCKED` in
[src/location.js](src/location.js) suppresses it along with the others.

### If you do not trust the compass

```
?alignwalk=1
```

Solves for the yaw from the two sensors you already have. Walk twenty metres:
GPS says which way you went in true bearings, SLAM says which way you went in
world axes, and one number relates them. It is a least-squares fit over every
pair with a long enough baseline, so it *sharpens* as you walk rather than
drifting as a compass does — `npm run test:georef` starts one 40° wrong and
recovers it to 0.00° over 60 m.

Off by default, because a spectator watching an aircraft over a river does not
walk and a stationary phone contributes nothing but GPS noise. Turn it on during
setup, walk a straight line, read the yaw off the HUD's **Georef** row, then
hard-code it with `?yaw0=`.

## What GPS is for now

Almost nothing, and that is the point.

```
?geolock=once     (default) place the world on the first good fix, then ignore
?geolock=slow     correct the world's position at ?corrate= m/s, default 0.5
?geolock=follow   correct it immediately — for diagnosis, not for use
```

`once` is not laziness. GPS is worth ±5–20 m; at the kilometre this installation
works over, 20 m is 1.1° of arc, which is invisible. SLAM's drift over a few
minutes standing still is centimetres. Correcting a good pose with a worse
measurement can only make it worse — and the correction itself is visible motion
where there should be none.

`slow` earns its place somewhere you walk a long way, where SLAM drift
eventually exceeds GPS error. Not this site. When it is on, corrections move the
**world**, never the camera; 0.5 m/s against a subject a kilometre off is
0.03°/s.

Later fixes are still *measured* under `once` — the HUD's **Georef** row shows
the world yaw and the metres of disagreement between GPS and SLAM. A few metres
is normal and ignored. A few hundred means the initial lock was wrong.

## Where tracking can fail

This is the honest risk of the port, and it is specific to this installation: an
aircraft over a river means a phone pointed at **sky and water**, and SLAM needs
visual texture to hold a pose. Point a phone at featureless sky and XR8 reports
`LIMITED` tracking; the world will drift until it gets something to hold on to.

What the build does about it:

- The tracking status is surfaced, not swallowed. `reality.trackingstatus` drives
  the HUD's **Tracking** row, and a status other than `NORMAL` puts a banner up
  asking for a glance at the skyline or the ground.
- `?worldtracking=0` drops to rotation only — the old engine's situation minus
  its compass problems — as an escape hatch if a site turns out to be hopeless.

What to check on site, because no test here can: that tracking holds through the
poses people actually adopt while following an aircraft, including the moment
they tip the phone up past the skyline. Keeping some bank, bridge or building in
the bottom of frame is usually enough, and is worth saying in the brief for where
people are asked to stand.

## Known constraints

- **The engine binary is proprietary and its licence is revocable.** Commercial
  use of this kind is permitted and attribution is mandatory — see
  [Licence](#licence-and-what-it-obliges-us-to-do). The platform is
  community-maintained since the February 2026 sunset, so there is no vendor
  support behind the tracker.
- **The engine costs 2.1 MB gzipped on first load**, served from our own origin
  now rather than 8th Wall's CDN. `?sim=1` is the only way to run without it, and
  it is a stand-in, not the engine.
- **SLAM needs visual texture.** Sky and open water are the failure case, and
  this installation points a phone at both. See
  [Where tracking can fail](#where-tracking-can-fail).
- **Absolute scale estimates your height** to place the ground plane. It is good
  to a few percent, which at 50 m of aircraft altitude is centimetres of error
  in the wrong direction — irrelevant here, but it is an estimate, not a
  measurement.
- **The georeference is only as good as its yaw.** One degree of yaw error is
  17 m of lateral offset at a kilometre. GPS error barely matters at this range;
  the compass is what to worry about, which is why `?yaw0=` exists and why
  `?alignwalk=1` exists as a way to measure it instead.
- **SLAM drifts if you walk far.** Metres over hundreds of metres of walking, and
  it accumulates rather than wandering. `?geolock=slow` is the answer where that
  applies; for a spectator standing still it does not.
- **iOS needs a tap and an explicit grant** for motion sensors — that is what the
  Start AR gate is for, and the request has to happen inside the user gesture.
  XR8 also needs the camera grant, which it requests itself on `XR8.run`.
- **GPS is still bounded by consumer GPS**, ±5-20 m, and it still decides where
  the world is placed *initially*. What has changed is that it no longer decides
  where the world is from moment to moment. If you need content pinned to a
  specific paving slab, that is image tracking or a VPS product (8th Wall's
  Lightship VPS, or image targets) — not this.

### Constraints that only apply to `?engine=locar`

Kept because the old engine is kept. None of it describes the default build.

- **Accuracy is bounded by consumer GPS**, roughly ±5–20 m outdoors. Content
  will drift by metres as fixes update. Two things soften it: positions are
  averaged over the last few fixes, and the camera eases between them rather
  than snapping. Neither invents precision that isn't there.

  A deadband was tried first — ignore fixes that move less than the reported
  accuracy — and it was wrong. At walking pace a fix moves about 1.4 m per
  second, well inside any threshold big enough to suppress noise, so it
  swallowed real walking and brought the lurching back. A filter cannot tell
  slow movement from noise by magnitude alone; averaging sidesteps the question
  because random error cancels and steady movement does not.

  What averaging cannot do is beat root n. Cutting the wander further means a
  longer window means more lag. If you need content pinned to the centimetre,
  that is a different technology — visual positioning or plane tracking — not
  more filtering. Don't design anything that requires the
  model to sit precisely on a specific paving slab — for that you need marker
  or image tracking, or a VPS product like Niantic's.
- **iOS needs a tap and an explicit grant** for motion sensors. That's what the
  Start AR gate is for; the request has to happen inside a user gesture.
- **The compass is the weak link.** iOS exposes a true-north heading; Android
  varies by device and can be tens of degrees out until calibrated.
- **Its field of view is nondeterministic.** LocAR builds its camera as
  `PerspectiveCamera(hFov / aspect, …)` and recomputes that on resize, so for an
  identical page load at an identical 414x896 viewport `camera.fov` comes out as
  either **80.0** (the constructor value) or **173.1** (the recompute), depending
  on whether its resize handler ran first. Probed over six loads: one 80.0, five
  173.1. That changes the apparent size of the model, so the size assertion in
  `tools/smoke-test.mjs` sits close to a boundary and fails occasionally on this
  path — most often the `fixed site` scenario, which lands nearest the edge.

  Not worth fixing in an engine this branch replaces, and not papered over by
  widening the assertion either. `?vfov=` pins the fov if you need a repeatable
  measurement. The 8th Wall engine has no equivalent: its projection comes from
  the camera intrinsics every frame.
- **LocAR's default projection is Web Mercator**, whose "metres" are inflated by
  `1/cos(latitude)` — at 51°N a model placed 20 m away renders 32 m away and
  looks far too small. [src/projection.js](src/projection.js) replaces it with a
  local tangent-plane projection in true metres. `npm test` covers this at the
  equator and at 68°N.
