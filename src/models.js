/**
 * The things we can put at the anchor. Pick one with `?model=`.
 *
 * `scaleBy: 'size'` normalises the model's longest dimension, which is the
 * right handle for an aircraft (you think in wingspan, not in height).
 * `scaleBy: 'height'` normalises the vertical extent, which is what you want
 * for anything standing on the ground.
 */
export const MODELS = {
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

export const DEFAULT_MODEL = 'airplane';
