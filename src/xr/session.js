import * as THREE from 'three';

/**
 * ── BRINGING UP 8TH WALL ──────────────────────────────────────────────────
 *
 * The engine is a local dependency, not a hosted script.
 *
 * It used to be the other way round: `apps.8thwall.com/xrweb?appKey=…`, keyed to
 * an account and locked to domains authorised in a dashboard. That platform was
 * retired in February 2026 and 8th Wall is now community-driven under Niantic
 * Spatial — the engine ships as `@8thwall/engine-binary` on npm, there is no app
 * key, and there is no domain allowlist. Which is a straightforward improvement:
 * no environment variable to forget, and deploy previews work.
 *
 * What it is not is bundled. `xr.js` and `xrextras.js` are served as static files
 * from `public/external/`, staged there by `npm run xr8:sync`, because the engine
 * fetches its SLAM chunks by path relative to itself and because its licence
 * permits distribution only in the original form.
 *
 * The tags are injected here rather than written into index.html, which is what
 * 8th Wall's own documentation suggests. The engine plus its tracker is 6 MB, and
 * a static tag downloads it on every page load — including `?engine=locar`, which
 * does not use it and which exists so the two engines can be compared on a phone.
 * `loadEngine` is called as this module is evaluated, so on the path that does
 * need the engine it still downloads in parallel with the aircraft.
 *
 * `@8thwall/engine-binary` exports an `XR8Promise` that does the waiting, and it
 * is deliberately not used: it never rejects. A missing or blocked script would
 * leave the gate spinning forever with nothing on screen to say why, which is the
 * failure mode most likely to happen in a field rather than at a desk.
 */

/** Staged by tools/sync-xr8.mjs. Paths are relative, to respect Vite's base. */
const ENGINE_SRC = 'external/xr/xr.js';
const XREXTRAS_SRC = 'external/xrextras/xrextras.js';

/** How long to wait for the runtime before deciding it is not coming. */
const LOAD_TIMEOUT_MS = 20_000;

const url = (path) => new URL(path, document.baseURI).href;

function injectScript(src, { preloadChunks } = {}) {
  if (document.querySelector(`script[data-xr8="${src}"]`)) return;
  const script = document.createElement('script');
  script.src = url(src);
  script.async = true;
  script.dataset.xr8 = src;
  /*
   * Start the tracker downloading alongside the engine rather than after it. It
   * is the larger half of the payload, and the gate is already waiting on a
   * 205 KB aircraft over mobile data.
   */
  if (preloadChunks) script.dataset.preloadChunks = preloadChunks;
  document.head.appendChild(script);
}

/**
 * Begin fetching the engine. Idempotent, and safe to call before anything else
 * is ready — the tags simply have to be in the document before we wait on them.
 */
export function loadEngine() {
  injectScript(ENGINE_SRC, { preloadChunks: 'slam' });
  injectScript(XREXTRAS_SRC);
}

/**
 * Why the engine is not here, as a sentence someone can act on.
 *
 * Worth the extra request: a 404 and a dropped connection produce the same
 * `error` event on a script element, and they are completely different problems
 * with completely different audiences. A 404 is ours — a deploy that skipped
 * `xr8:sync`. A network failure belongs to whoever is standing outside, and
 * telling them to add `?sim=1` would be nonsense, because the simulator has no
 * tracking in it.
 */
async function diagnose() {
  try {
    const response = await fetch(url(ENGINE_SRC), { method: 'HEAD', cache: 'no-store' });
    if (response.status === 404) {
      return 'The 8th Wall engine is missing from this build — run `npm run xr8:sync`. '
        + 'Add ?sim=1 to run without it.';
    }
    if (!response.ok) {
      return `The 8th Wall engine could not be loaded (${response.status}). Please reload.`;
    }
    // It is there and it was served; it just never announced itself. Almost
    // always the tracker chunks failing partway on a weak connection.
    return 'The 8th Wall engine did not start. Check your connection and reload.';
  } catch {
    return 'The 8th Wall engine could not be reached. Check your connection and reload.';
  }
}

/**
 * Resolve once `window.XR8` exists, or reject with something a person standing
 * outdoors can act on.
 *
 * The engine announces itself with an `xrloaded` event rather than on script
 * load, because it finishes initialising after the tag is done.
 */
export function waitForXR8({ timeout = LOAD_TIMEOUT_MS } = {}) {
  if (window.XR8) return Promise.resolve(window.XR8);
  loadEngine(); // no-op if the tags are already in, and a safety net if not

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('xrloaded', onLoaded);
      diagnose().then((message) => reject(new Error(message)));
    }, timeout);

    function onLoaded() {
      clearTimeout(timer);
      resolve(window.XR8);
    }
    window.addEventListener('xrloaded', onLoaded, { once: true });
  });
}

/**
 * Widen the depth range of whatever projection XR8 just handed us.
 *
 * XR8 writes `camera.projectionMatrix` from the real camera intrinsics every
 * frame — which is the single best thing about this port, because it retires all
 * of `lensFov`, `verticalFov` and the hand-nulled field-of-view matching that
 * the LocAR build needed. What it also writes is its own near and far planes,
 * and they are sized for content within arm's reach.
 *
 * This installation is not that. The anchor is up to a kilometre off, the
 * racetrack's straight leg is 2475 m, and the far end of it is further still —
 * so with XR8's own far plane the aircraft simply vanishes for most of its
 * circuit, which reads as the model failing to load.
 *
 * Only the two depth terms are touched. Focal length and principal point stay
 * exactly as measured, so registration is unaffected: a perspective matrix keeps
 * its whole calibration in the other entries.
 */
export function setDepthRange(camera, near, far) {
  const e = camera.projectionMatrix.elements;
  const wanted22 = -(far + near) / (far - near);
  const wanted32 = (-2 * far * near) / (far - near);
  if (Math.abs(e[10] - wanted22) < 1e-9 && Math.abs(e[14] - wanted32) < 1e-9) return;
  e[10] = wanted22;
  e[14] = wanted32;
  camera.near = near;
  camera.far = far;
  // Three caches the inverse for unprojection and for Raycaster; it is not
  // recomputed by writing to `elements` directly.
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/**
 * The bearing, in world-frame terms, that an object is facing. Identical maths
 * to the LocAR build's `headingOf`, but the answer means something different:
 * there it was a compass bearing, here it is an angle within XR8's own frame,
 * and turning one into the other is exactly what georef's `yaw` is for.
 */
export function worldBearingOf(object) {
  const forward = object.getWorldDirection(new THREE.Vector3());
  return ((Math.atan2(forward.x, -forward.z) * 180) / Math.PI + 360) % 360;
}

/**
 * Start a world-tracking session and hand back three's scene graph.
 *
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {boolean} options.worldTracking  false falls back to rotation only
 * @param {'absolute'|'responsive'} options.scale
 * @param {number} options.near   depth range, in metres — see setDepthRange
 * @param {number} options.far
 * @param {(dt: number) => void} options.onUpdate      once per frame, pre-render
 * @param {(state: object) => void} options.onTracking  tracking status changes
 * @param {(error: Error) => void} options.onError
 */
export async function startSession({
  canvas,
  worldTracking = true,
  scale = 'absolute',
  near = 0.01,
  far = 8000,
  onUpdate,
  onTracking,
  onError,
}) {
  const XR8 = window.XR8;
  const XRExtras = window.XRExtras;

  XR8.XrController.configure({
    /*
     * 'absolute' is the whole point of choosing 8th Wall for this. It puts the
     * camera at its real height above the detected ground plane and renders
     * content at true metric scale, so a 60 m aircraft 1 km away is 60 m and
     * 1 km, and the geodetic maths in georef.js needs no scale factor at all.
     *
     * 'responsive' scales content to keep it a constant size on screen, which is
     * right for a product visualiser on a tabletop and wrong for anything with a
     * real-world position.
     */
    scale,
    /*
     * True disables SLAM and leaves 3DoF rotation only — the LocAR situation,
     * minus its compass problems. It is here as an escape hatch for a site where
     * tracking cannot hold: see the note about featureless sky in the README.
     */
    disableWorldTracking: !worldTracking,
    enableLighting: false,
    enableWorldPoints: false,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const clock = new THREE.Clock();

    const appModule = {
      name: 'tccc-ar',

      onStart: () => {
        const { scene, camera, renderer } = XR8.Threejs.xrScene();
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;

        /*
         * Widen the depth range immediately before the projection matrix is
         * used, by wrapping the render call rather than by doing it in our own
         * onUpdate.
         *
         * The obvious version — adjust it once per frame in onUpdate — depends
         * on XR8 writing the matrix earlier in the pipeline than our module
         * runs, which is an internal ordering we do not control and which would
         * fail silently if it ever changed: the aircraft would simply be clipped
         * away past a kilometre and look like a model that failed to load.
         * Hooking the render is ordering-independent, because whatever wrote the
         * matrix has finished by the time anything draws with it.
         */
        const render = renderer.render.bind(renderer);
        renderer.render = (renderScene, renderCamera) => {
          if (renderCamera === camera) setDepthRange(camera, near, far);
          render(renderScene, renderCamera);
        };

        settled = true;
        resolve({ XR8, scene, camera, renderer });
      },

      /*
       * Scene updates go here, not in a renderer.setAnimationLoop. XR8 owns the
       * frame: it pulls a camera frame, computes a pose, writes it onto the
       * three camera, and XR8.Threejs renders. Driving our own loop alongside
       * that would render poses from a different instant than the frame behind
       * them, which is the exact defect this port removes.
       */
      onUpdate: () => {
        if (!XR8.Threejs.xrScene()) return;
        onUpdate?.(Math.min(clock.getDelta(), 0.1));
      },

      onException: (error) => {
        const wrapped = error instanceof Error ? error : new Error(String(error?.message ?? error));
        if (!settled) {
          settled = true;
          reject(wrapped);
          return;
        }
        onError?.(wrapped);
      },

      listeners: [
        /*
         * LIMITED tracking is the failure mode to design for here, and it has a
         * specific cause at this installation: an aircraft over a river means a
         * phone pointed at sky and water, and SLAM needs texture to track. The
         * status is surfaced rather than swallowed so the HUD can ask for a
         * glance at the skyline instead of silently drifting.
         */
        {
          event: 'reality.trackingstatus',
          process: ({ status, reason }) => onTracking?.({ status, reason }),
        },
      ],
    };

    const modules = [
      // Order matters: the feed is drawn first, then the scene composited over it.
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.Threejs.pipelineModule(),
      XR8.XrController.pipelineModule(),
      appModule,
    ];
    // Optional, and treated as optional: a CDN hiccup on xrextras should degrade
    // the error reporting, not take the experience down with it.
    if (XRExtras) {
      modules.push(
        XRExtras.AlmostThere.pipelineModule(),   // unsupported browser -> a way out
        XRExtras.FullWindowCanvas.pipelineModule(), // rotation and toolbar resizes
        XRExtras.RuntimeError.pipelineModule(),
      );
    }

    XR8.addCameraPipelineModules(modules);

    try {
      XR8.run({ canvas });
    } catch (error) {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}
