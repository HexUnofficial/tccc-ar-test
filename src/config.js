/**
 * Runtime configuration. Every value can be overridden with a URL query
 * parameter, which is what makes field testing bearable — you can retune
 * placement, scale and facing from the phone's address bar without a redeploy.
 */
import {
  DEFAULT_MODE, FLIGHT, FLIGHT_HEADING, INSTALLATION, LOCKED, RELATIVE_PLACEMENT,
} from './location.js';
import { DEFAULT_MODEL, MODELS } from './models.js';

const params = new URLSearchParams(location.search);

/**
 * Placement parameters are suppressed when LOCKED, so a deployed experience
 * can't be relocated from the address bar. Presentation parameters stay live.
 */
const placed = (key) => (LOCKED ? null : params.get(key));

/**
 * A placement number from the query string, or the fallback.
 *
 * Not `Number(x) || fallback`: that treats a legitimate 0 as absent, and
 * longitude 0 is the Greenwich meridian — which runs through London, the one
 * place this is guaranteed to be used.
 */
const placedNum = (key, fallback) => {
  const raw = placed(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

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
      /**
       * Real-world size in metres, along whichever axis `scaleBy` names.
       * FLIGHT.size is the installation's own figure, set by the map picker;
       * it falls back to the per-model default when left null.
       */
      /*
       * FLIGHT.size describes the aircraft, so it must not reach the other
       * models: `FLIGHT.size ?? preset.size` was always taking the former,
       * which quietly made the witch 400 m tall.
       */
      size: num('size', num('height',
        preset.behaviour === 'flight' ? FLIGHT.size ?? preset.size : preset.size)),
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
    length: params.get('length') ?? FLIGHT.length,

    /**
     * Radius of the 180s at each end, in metres. This also sets how far apart
     * the two legs are (twice the radius), so keep it inside the river's width
     * or the aircraft will turn over the bank.
     */
    turnRadius: num('turn', FLIGHT.turnRadius),

    /**
     * Airspeed in m/s. 20 m/s is 72 km/h — slow for a real aircraft, but it
     * has to be followable by someone panning a phone from 300 m away.
     */
    speed: num('speed', FLIGHT.speed),

    /**
     * Height above the anchor, in metres. At 50 m the aircraft sits about 10°
     * above the horizon from 300 m away, which clears the far bank; drop it and
     * it risks hiding behind buildings. The GLB's own clip bobs around this.
     */
    altitude: num('alt', FLIGHT.altitude),
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
    lat: placedNum('lat', INSTALLATION.lat),
    lon: placedNum('lon', INSTALLATION.lon),
    bearing: num('bearing', RELATIVE_PLACEMENT.bearing),
    distance: num('distance', RELATIVE_PLACEMENT.distance),
    elevation: placedNum('elev', INSTALLATION.elevation),
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

    /**
     * How many recent fixes to average into the position we actually use.
     *
     * A stationary phone reports a fix that wanders continuously inside its
     * error circle, and following that drags the scene sideways while nobody is
     * moving. A deadband was tried first and rejected: at walking pace a fix
     * moves about 1.4 m per second, well inside any threshold big enough to
     * suppress noise, so it swallowed real walking and reintroduced lurching.
     *
     * Averaging cannot confuse the two. Random error cancels — n fixes cut it
     * by root n — while steady movement passes through with a fixed lag of
     * roughly half the window. Three fixes is the compromise: it halves the
     * wander while lagging a walk by about 1.5 s, or 2 m — invisible against
     * GPS's own +/-10 m, and far less objectionable than the scene sliding
     * about while you stand still.
     */
    averageFixes: Math.max(1, Math.round(num('avg', 3))),
  },

  /**
   * How long the view takes to catch up to the sensors, in seconds.
   *
   * A time constant, not a fraction: the camera eases towards the latest
   * reading once per rendered frame, so this is frame-rate independent and
   * means something concrete — after this long, roughly two thirds of the way
   * there. It replaced LocAR's per-event factor, which quantised all motion to
   * sensor arrivals and was the actual source of the jitter while panning.
   *
   * 0.08 s is deliberately small but not zero. It filters compass noise while
   * standing still, and it leaves the overlay very slightly behind the phone,
   * which is the right direction to err: the camera feed is itself delayed by
   * some tens of milliseconds, so a snap-to-sensor overlay runs ahead of the
   * picture it is drawn over. 0 tracks the sensors exactly.
   */
  orientationSmoothing: num('smoothrot', 0.08),

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
   * Defaults to `none`: over a live camera feed in front of an audience, the
   * arrow is the only overlay that earns its place. Note what that costs — a
   * denied location permission or a lost fix now says nothing at all, so if the
   * aircraft fails to appear on site, reach for `?ui=debug` to find out why.
   *
   * `ui` is the only thing that turns the interface on, and `?debug=1` is
   * deliberately inert. It used to be a shorthand for `?ui=debug`, and the
   * picker stamped it into every URL and QR it emitted — so codes that are
   * already printed and about to be handed out carry it. Honouring it would put
   * the instrument panel over the camera feed for everyone who scans one, which
   * is the opposite of what those codes are for. Type `?ui=debug` when you want
   * the panel; nothing in a link can ask for it on your behalf.
   */
  ui: params.get('ui') ?? 'none',

  /** Go fullscreen on start where the browser allows it (not iPhone Safari). */
  fullscreen: flag('fullscreen', true),
};
