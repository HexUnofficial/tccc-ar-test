/**
 * The things we can put at the anchor. Pick one with `?model=`.
 *
 * `scaleBy: 'size'` normalises the model's longest dimension, which is the
 * right handle for an aircraft (you think in wingspan, not in height).
 * `scaleBy: 'height'` normalises the vertical extent, which is what you want
 * for anything standing on the ground.
 */
export const MODELS = {
  /**
   * The TCCC banner-towing aircraft, converted from FBX (see tools/fbx-to-glb.mjs)
   * and Draco-compressed: 289k triangles down to 83k, 27 MB down to 0.6 MB.
   *
   * It has no animation clip of any kind, so the flight path is the only motion.
   * The banner trails behind the aircraft along its +Z, which is why the nose
   * needs turning through 180 degrees to fly down -Z.
   */
  tccc: {
    url: 'models/tccc-airplane.glb',
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
    url: 'models/airplane.glb',
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
    url: 'models/witch.glb',
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
