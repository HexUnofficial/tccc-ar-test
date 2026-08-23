import * as THREE from 'three';

/**
 * ── BRINGING UP 8TH WALL ──────────────────────────────────────────────────
 *
 * XR8 is not an npm package. It is a hosted script keyed to your account and to
 * the domains you have authorised in the 8th Wall dashboard, and it refuses to
 * run anywhere else — so it cannot be bundled, vendored or served from our own
 * origin, and it is loaded at runtime instead.
 *
 * That has one consequence worth stating plainly: this branch cannot run at all
 * without an app key. See `VITE_XR8_APP_KEY` in README, and `?sim=1` for the
 * desktop path that skips XR8 entirely.
 */

const XR8_SRC = 'https://apps.8thwall.com/xrweb';
const XREXTRAS_SRC = 'https://cdn.8thwall.com/web/xrextras/xrextras.js';

function loadScript(src, ready, event) {
  if (ready()) return Promise.resolve(ready());
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-xr="${event}"]`);
    if (!existing) {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.xr = event;
      script.addEventListener('error', () =>
        reject(new Error(`Could not load ${src} — check the network and the app key.`)));
      document.head.appendChild(script);
    }
    // Both scripts announce themselves with an event rather than resolving on
    // load, because they finish initialising after the tag is done.
    window.addEventListener(event, () => resolve(ready()), { once: true });
  });
}

/** Fetch xrextras and xrweb, in that order. Resolves once XR8 exists. */
export async function loadXR8(appKey) {
  if (!appKey) {
    throw new Error(
      'No 8th Wall app key. Set VITE_XR8_APP_KEY (see README), or add ?sim=1 to run without XR8.',
    );
  }
  // XRExtras first: its modules are referenced while building the pipeline, and
  // it is the smaller of the two, so a failure here surfaces sooner.
  await loadScript(XREXTRAS_SRC, () => window.XRExtras, 'xrextrasloaded');
  await loadScript(`${XR8_SRC}?appKey=${encodeURIComponent(appKey)}`, () => window.XR8, 'xrloaded');
  return window.XR8;
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
