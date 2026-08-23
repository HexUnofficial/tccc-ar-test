/**
 * Which engine to run.
 *
 * The 8th Wall build is the experience. The LocAR build is kept reachable with
 * `?engine=locar` for one reason: the case for the port is a claim about how
 * something feels on site, and the only way to settle that is to hand someone a
 * phone and let them switch between the two while standing in the same spot
 * looking at the same aircraft. A description of the difference is not evidence.
 *
 * They are separate dynamic imports so neither engine's dependencies land in the
 * other's bundle — LocAR and three's DeviceOrientation machinery are dead weight
 * for the XR8 path, and XR8 is loaded from 8th Wall's CDN rather than bundled at
 * all. Vite code-splits on these two lines.
 */
const engine = new URLSearchParams(location.search).get('engine');

if (engine === 'locar') {
  import('./main.js');
} else {
  import('./xr/main.js');
}
