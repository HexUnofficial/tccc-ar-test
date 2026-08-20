# tccc-ar-test

GPS-anchored AR for the mobile web. Points a phone's camera at the world, works
out where you are and which way you're facing, and holds a 3D model at a fixed
real-world coordinate. Runs in mobile Safari and Android Chrome — no app, no
app store, no WebXR requirement.

Built on [LocAR.js](https://github.com/AR-js-org/locar.js) (the successor to
AR.js's location-based mode) and three.js.

## Quick start

```bash
npm install
npm run dev
```

Open the **https** URL it prints. On a laptop, add `?sim=1`:

```
https://localhost:5173/?sim=1
```

That fakes the GPS, uses your laptop webcam for the passthrough feed, and gives
you **drag to look around** and **WASD to walk**. Enough to check placement,
scale, framing and animation without leaving your desk.

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
| `height` | `2.4` | Real-world height of the model, in metres |
| `yaw` | `0` | Degrees of extra rotation, if the model faces the wrong way |
| `faceuser` | `1` | `0` to stop it turning to face you |
| `minacc` | `100` | Ignore GPS fixes worse than this many metres |
| `mindist` | `5` | Metres you must move before the scene re-projects |
| `sim` | `0` | `1` for desktop simulation |
| `debug` | `1` | `0` to hide the telemetry panel |

Example: `?mode=relative&distance=10&bearing=270&height=3`

## The model

**Keep the GLB.** glTF/GLB is the native format of the web — three.js loads it
directly, it carries PBR materials, skinning and animation in one binary file,
and it's an open Khronos standard. FBX is a proprietary interchange format; the
three.js FBX loader is heavier, slower, and supports fewer material features.
If you're handed an FBX, convert it to GLB rather than shipping it.

`witch.glb` as supplied is 8.2 MB, which is a rough download over mobile data.
Almost all of that is four 2048px PNGs — the geometry is only 13k triangles.

```bash
npm run optimize
```

resizes textures to 1024px and re-encodes them as WebP, writing
`public/models/witch.glb` at **1.2 MB (85% smaller)** with no visible
difference at AR viewing distances. Re-run it whenever the source model
changes. Tune with `MAX_TEXTURE=512 WEBP_QUALITY=75 npm run optimize`.

The model is auto-scaled to `height` metres and its feet placed on the ground,
so you don't need to care what units it was authored in. The first animation
clip (`Take 001`) loops continuously.

## Automated tests

```bash
npm test
```

Builds, serves, and drives the real page in headless Chromium with a synthetic
camera and a mocked GPS fix, across six placements. It checks that the model
downloads, the camera stream starts, the GPS fix lands the model at the right
distance and bearing, the model actually rasterises at the correct physical
size, and the direction arrow appears and hides when it should.

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

What none of it can tell you: compass accuracy, magnetometer drift, real GPS
jitter, sunlight legibility, or thermal throttling. Those need a phone and a
pavement.

## Deploying

```bash
npm run build      # -> dist/
```

Static output — host it on anything (Vercel, Netlify, S3, Cloudflare Pages).
Two hard requirements:

- **HTTPS.** Camera, geolocation and motion sensors are all refused on plain
  HTTP. There is no way around this.
- **Correct MIME type for `.glb`** (`model/gltf-binary`). Most hosts get this
  right; if the model silently fails to load, check this first.

## Known constraints

- **Accuracy is bounded by consumer GPS**, roughly ±5–20 m outdoors. Content
  will drift by metres as fixes update. Don't design anything that requires the
  model to sit precisely on a specific paving slab — for that you need marker
  or image tracking, or a VPS product like Niantic's.
- **iOS needs a tap and an explicit grant** for motion sensors. That's what the
  Start AR gate is for; the request has to happen inside a user gesture.
- **The compass is the weak link.** iOS exposes a true-north heading; Android
  varies by device and can be tens of degrees out until calibrated.
- **LocAR's default projection is Web Mercator**, whose "metres" are inflated by
  `1/cos(latitude)` — at 51°N a model placed 20 m away renders 32 m away and
  looks far too small. [src/projection.js](src/projection.js) replaces it with a
  local tangent-plane projection in true metres. `npm test` covers this at the
  equator and at 68°N.
