/**
 * Runtime configuration. Every value can be overridden with a URL query
 * parameter, which is what makes field testing bearable — you can retune
 * placement, scale and facing from the phone's address bar without a redeploy.
 */
import { DEFAULT_MODE, FLIGHT_HEADING, INSTALLATION, LOCKED, RELATIVE_PLACEMENT } from './location.js';
import { DEFAULT_MODEL, MODELS } from './models.js';

const params = new URLSearchParams(location.search);

/**
 * Placement parameters are suppressed when LOCKED, so a deployed experience
 * can't be relocated from the address bar. Presentation parameters stay live.
 */
const placed = (key) => (LOCKED ? null : params.get(key));

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
  /** The chosen preset from models.js, with URL overrides folded in. */
  model: (() => {
    const preset = MODELS[params.get('model')] ?? MODELS[DEFAULT_MODEL];
    return {
      ...preset,
      url: `${import.meta.env.BASE_URL}${preset.url}`,
      /** Real-world size in metres, along whichever axis `scaleBy` names. */
      size: num('size', num('height', preset.size)),
      /** Extra yaw in degrees, to correct a model that doesn't face -Z. */
      yawOffset: num('yaw', 0),
      /** Rotate to face the viewer. Right for a character, wrong in flight. */
      faceUser: flag('faceuser', preset.faceUser),
    };
  })(),

  /** The circuit flown by models with `behaviour: 'flight'`. */
  flight: {
    /**
     * racetrack = a straight leg, a 180 at the end, a straight leg back. Unlike
     * `circle` or `eight` it never doubles back through the middle, so it reads
     * as an aircraft beating up and down a line.
     */
    shape: params.get('path') ?? 'racetrack',

    /** 'across', 'along', or a compass bearing in degrees. See location.js. */
    heading: placed('heading') ?? FLIGHT_HEADING,

    /**
     * Length of the straight leg in metres — the stretch of river it patrols.
     * Deliberately longer than a phone's field of view: the aircraft leaving
     * frame and being followed is the point. 'fit' instead sizes the leg to the
     * frame at the anchor's range, which is handy for close-up testing.
     */
    length: params.get('length') ?? num('length', 250),

    /**
     * Radius of the 180s at each end, in metres. This also sets how far apart
     * the two legs are (twice the radius), so keep it inside the river's width
     * or the aircraft will turn over the bank.
     */
    turnRadius: num('turn', 40),

    /**
     * Airspeed in m/s. 20 m/s is 72 km/h — slow for a real aircraft, but it
     * has to be followable by someone panning a phone from 300 m away.
     */
    speed: num('speed', 20),

    /**
     * Height above the anchor, in metres. At 50 m the aircraft sits about 10°
     * above the horizon from 300 m away, which clears the far bank; drop it and
     * it risks hiding behind buildings. The GLB's own clip bobs around this.
     */
    altitude: num('alt', 50),
    /** Maximum roll into a turn, in degrees. */
    maxBank: num('bank', 45),
    /** Seconds to roll into or out of a bank. 0 snaps. */
    rollTime: num('rolltime', 0.8),

    /** Only used by the `circle` and `eight` shapes. */
    radius: num('radius', 30),
    period: num('period', 16),
  },

  /** Placement — edit location.js, not this. Query params override for testing. */
  anchor: {
    mode: placed('mode') ?? DEFAULT_MODE,
    lat: Number(placed('lat')) || INSTALLATION.lat,
    lon: Number(placed('lon')) || INSTALLATION.lon,
    bearing: num('bearing', RELATIVE_PLACEMENT.bearing),
    distance: num('distance', RELATIVE_PLACEMENT.distance),
    elevation: Number(placed('elev')) || INSTALLATION.elevation,
    /**
     * Past this many metres the model is a speck and walking does nothing
     * perceptible, which reads as "the AR is broken" rather than "you are in
     * the wrong city". Beyond it we say so explicitly.
     */
    farWarning: num('farwarn', MODELS[params.get('model')]?.farWarning
      ?? MODELS[DEFAULT_MODEL].farWarning),
  },

  gps: {
    /** Ignore fixes worse than this, in metres. Phones report 5-30m outdoors. */
    minAccuracy: num('minacc', 100),
    /**
     * Only re-project the scene once you've moved this far, in metres. Keep it
     * small: at 5 m the model's size visibly snaps between steps as you walk,
     * which reads as "the AR isn't responding to me".
     */
    minDistance: num('mindist', 1),
    /**
     * How much of a GPS interval to spend catching up to each new fix.
     *
     * The camera travels at a constant speed, latched when the fix arrives, so
     * that it arrives just as the next one lands — which means it is always in
     * motion at roughly your walking pace instead of lurching forward and then
     * coasting.
     *
     * Slightly over 1 deliberately: aiming to arrive exactly on time means
     * occasionally arriving early and freezing until the next fix, which is the
     * artefact we're trying to remove. Measured at walking pace (tools/
     * motion-test.mjs), 1.2 cuts speed variability from 7.8 to 0.08 and stalled
     * frames from 98% to 0.5%, costing 0.8 m of lag — nothing against GPS's own
     * +/-5-20 m. 0 disables the follow entirely and snaps to each fix.
     */
    smoothing: num('smooth', 1.2),
  },

  /** Desktop testing: fake GPS, mouse-look, WASD movement. */
  simulate: flag('sim', false),

  /**
   * Where the simulated viewer stands, as a bearing from the anchor. Standing
   * due south of a run that happens to lie north-south means watching it fly
   * straight at you; the map picker sets this perpendicular to the run so you
   * see the whole sweep, the way you would from a riverbank.
   */
  viewFrom: num('viewfrom', 180),

  /**
   * How much interface to draw over the camera feed.
   *
   *   minimal  the direction arrow, plus a banner only when something is wrong
   *   debug    everything, including the live telemetry panel
   *   none     the arrow alone, nothing else, ever
   *
   * `?debug=1` is kept as a shorthand for `?ui=debug`.
   */
  ui: flag('debug', false) ? 'debug' : (params.get('ui') ?? 'minimal'),

  /** Go fullscreen on start where the browser allows it (not iPhone Safari). */
  fullscreen: flag('fullscreen', true),
};
