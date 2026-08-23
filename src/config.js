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
   * How long the view takes to catch up to the sensors, in seconds. 0 tracks
   * them exactly.
   *
   * A time constant, not a fraction: the camera eases towards the latest reading
   * once per rendered frame, so it is frame-rate independent. It exists because
   * LocAR only writes rotation when a reading lands, which leaves the view
   * frozen between them — motion quantised to the sensor's clock rather than the
   * display's.
   *
   * Any easing also lags the phone, and because the scene is pinned to compass
   * north that lag drifts the whole world along with a pan, which reads as the
   * aircraft following you rather than holding its anchor. Measured while
   * panning at 60°/s with readings at 30Hz:
   *
   *     tau     world lag   frames frozen
   *     0.08      4.02°        0%
   *     0.02      0.57°        0%
   *     0         0.00°       44%
   *
   * Set to 0 deliberately, after trying the alternatives on a phone. On paper
   * 0.02 looks like the better trade — half a degree is a couple of pixels, and
   * nothing repeats a frame. On the device the drift was the thing that showed,
   * and the stepping was not. Both were judged by eye on an iPhone, which beats
   * either column above.
   *
   * Raise it if the stepping ever becomes the more objectionable of the two.
   * 0.01 is the gentlest setting that still refreshes every frame.
   */
  orientationSmoothing: num('smoothrot', 0),

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

  /**
   * Vertical field of view of the rendered camera, in degrees. 0 keeps LocAR's.
   *
   * This is the one thing that can make content drift with a pan no matter how
   * good the tracking is, because it is not a timing error at all — it is a
   * scale error between angles and pixels. If the render is wider than the
   * lens, a real rotation of N degrees moves the world across fewer pixels than
   * the camera feed moves behind it, so everything drags along with the pan and
   * settles when you stop. Exactly what latency looks like, and immune to
   * every latency fix.
   *
   * LocAR builds its camera as `PerspectiveCamera(hFov / aspect, aspect, …)`.
   * Three's first argument is the VERTICAL fov, and dividing is not the
   * conversion — it is `2·atan(tan(hFov/2) / aspect)`. With hFov 80 on a
   * 414×896 viewport that yields 173.1° vertical, about 165° horizontal: a
   * fisheye, against a phone lens of roughly 65–70°.
   *
   * What it should be depends on the lens and on the crop, since the feed is
   * drawn with `object-fit: cover`. For a 16:9 feed in portrait only 26% of its
   * width survives, giving roughly 42–45° vertical; if iOS hands over an
   * already-portrait feed it is nearer 100°. So the honest answer is a number
   * you null by eye: set it, pan, and see whether the model still slides
   * against the background.
   *
   *   ?vfov=50   a reasonable first guess
   *   ?vfov=0    LocAR's own value, for comparison
   *
   * Beware it also changes apparent size — narrower fov magnifies. At 173° the
   * aircraft renders about a third of the size it should, which is worth
   * remembering given `size` is currently set to 400 m.
   */
  verticalFov: Math.max(0, num('vfov', 0)),

  /**
   * The camera's own horizontal field of view, in degrees, across the long axis
   * of the frame it captures. 0 disables the correction entirely.
   *
   * This is the only genuinely unknown quantity in the sum above: iOS will not
   * tell us the lens, but everything else can be measured at runtime. Given the
   * video's real dimensions and the viewport's, the cover-crop is determined,
   * and the crop preserves the container's aspect exactly — so a single vertical
   * fov describes the view and can be derived rather than guessed. That removes
   * the part that was guesswork, namely whether iOS hands over a landscape or
   * an already-rotated portrait feed, which moves the answer from 42° to 68°.
   *
   * 68 is the iPhone main wide camera: 26 mm equivalent is 2·atan(18/26), about
   * 69° across the long axis. Ultra-wide is nearer 100 and the 2x is nearer 37,
   * so change this if the lens changes. `?vfov=` still forces an exact vertical
   * value and wins over this.
   */
  lensFov: Math.max(0, num('lens', 68)),

  /** Go fullscreen on start where the browser allows it (not iPhone Safari). */
  fullscreen: flag('fullscreen', true),
};
