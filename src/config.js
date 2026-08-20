/**
 * Runtime configuration. Every value can be overridden with a URL query
 * parameter, which is what makes field testing bearable — you can retune
 * placement, scale and facing from the phone's address bar without a redeploy.
 */
import { DEFAULT_MODE, INSTALLATION, RELATIVE_PLACEMENT } from './location.js';

const params = new URLSearchParams(location.search);

const num = (key, fallback) => {
  const value = Number.parseFloat(params.get(key));
  return Number.isFinite(value) ? value : fallback;
};

const flag = (key, fallback) => {
  if (!params.has(key)) return fallback;
  const value = params.get(key).toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no';
};

export const config = {
  model: {
    url: `${import.meta.env.BASE_URL}models/witch.glb`,
    /** Real-world height in metres. The model is auto-scaled to match. */
    heightMeters: num('height', 2.4),
    /** Extra yaw in degrees, to correct a model that doesn't face -Z. */
    yawOffset: num('yaw', 0),
    /** Rotate to face the viewer. Right for a character, wrong for a building. */
    faceUser: flag('faceuser', true),
  },

  /** Placement — edit location.js, not this. Query params override for testing. */
  anchor: {
    mode: params.get('mode') ?? DEFAULT_MODE,
    lat: num('lat', INSTALLATION.lat),
    lon: num('lon', INSTALLATION.lon),
    bearing: num('bearing', RELATIVE_PLACEMENT.bearing),
    distance: num('distance', RELATIVE_PLACEMENT.distance),
    elevation: num('elev', INSTALLATION.elevation),
  },

  gps: {
    /** Ignore fixes worse than this, in metres. Phones report 5-30m outdoors. */
    minAccuracy: num('minacc', 100),
    /** Only re-project the scene once you've moved this far, in metres. */
    minDistance: num('mindist', 5),
  },

  /** Desktop testing: fake GPS, mouse-look, WASD movement. */
  simulate: flag('sim', false),
  debug: flag('debug', true),
};
