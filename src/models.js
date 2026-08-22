/**
 * The things we can put at the anchor. Pick one with `?model=`.
 *
 * `scaleBy: 'size'` normalises the model's longest dimension, which is the
 * right handle for an aircraft (you think in wingspan, not in height).
 * `scaleBy: 'height'` normalises the vertical extent, which is what you want
 * for anything standing on the ground.
 *
 * Every `url` carries a `?v=` matching the file's own content (first 8 hex of
 * its sha256 — `sha256sum public/models/*.glb`). netlify.toml marks `/models/*`
 * `immutable, max-age=31536000`, which tells every browser and CDN in between
 * to never revalidate that URL again — so replacing the GLB at the same path
 * silently keeps serving whichever bytes a client cached first. That's what
 * made the textured aircraft read as flat white after it shipped: the file on
 * disk had textures, but nobody's browser was still asking. Bump the `v` to
 * match the new hash whenever you re-run a `model:*` script.
 */
export const MODELS = {
  /**
   * The TCCC banner-towing aircraft: Draco-compressed geometry, 289k triangles
   * down to 83k, textures re-encoded from WebP to PNG.
   *
   * The glTF-Transform export's 16 textures were WebP behind a *required*
   * EXT_texture_webp — fine on desktop Chromium, but the actual field test on
   * an iPhone rendered the whole aircraft flat black, textures gone. WebP
   * decoding through GLTFLoader's ImageBitmapLoader path is the prime suspect
   * (see tools/optimize-geometry.mjs and the model:tccc script), and it isn't
   * worth chasing further: PNG has no decoder to fail. Costs ~2.5x the
   * transferred bytes; for a one-time load before a client demo, that's the
   * right side to be wrong on.
   *
   * The banner trails behind the aircraft along its +Z, which is why the nose
   * needs turning through 180 degrees to fly down -Z.
   */
  tccc: {
    url: 'models/tccc-airplane.glb?v=61a69104',
    scaleBy: 'size',
    /*
     * Length of the whole assembly — aircraft, tow line and banner. Realistic
     * would be about 30 m, which leaves the banner roughly 3 m tall and quite
     * unreadable from across a river. 60 m is a deliberate compromise: at a few
     * hundred metres there is no nearby reference to judge scale against, so
     * the exaggeration costs little and the banner is the entire point.
     */
    size: 60,
    behaviour: 'flight',
    groundShadow: false,
    faceUser: false,
    noseOffset: 180,
    farWarning: 1500,
  },

  airplane: {
    url: 'models/airplane.glb?v=0ce16037',
    /** Longest dimension in metres — roughly a light aircraft's wingspan. */
    scaleBy: 'size',
    size: 14,
    /** Flies a circuit; must not be seated on the ground or billboarded. */
    behaviour: 'flight',
    groundShadow: false,
    faceUser: false,
    /**
     * Degrees of yaw bringing the model's nose onto its direction of travel.
     * This GLB is authored nose-along--X (verified by rendering it down each
     * axis), and the flight code flies everything along -Z, so it needs -90.
     */
    noseOffset: -90,
    /**
     * You are *supposed* to watch an aircraft over a river from a few hundred
     * metres away, so the "you're nowhere near the anchor" warning has to be
     * far more permissive here than for something you walk up to.
     */
    farWarning: 1500,
  },

  witch: {
    url: 'models/witch.glb?v=92a86c86',
    scaleBy: 'height',
    size: 2.4,
    behaviour: 'ground',
    groundShadow: true,
    faceUser: true,
    noseOffset: 0,
    farWarning: 200,
  },
};

export const DEFAULT_MODEL = 'tccc';
