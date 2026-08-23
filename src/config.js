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
   * 0.02 because that is what this always effectively was, and 0 was below it.
   *
   * Before any of this, LocAR did the filtering itself: `smoothingFactor: 0.4`
   * made it slerp 60% of the way to each reading as the reading arrived. That
   * was disabled when the easing moved to a per-frame clock, and the setting
   * was then taken down to 0 on the strength of the table above — which left no
   * filtering at all, and passed raw compass noise straight to the screen. It
   * was jitterier than the build it replaced, and the table is why: it measures
   * lag and repeated frames, neither of which is noise.
   *
   * The equivalence, so this is not guessed at again: retaining 0.4 of the error
   * per event is a time constant of -dt/ln(0.4) — 18 ms if readings arrive at
   * 60Hz, 36 ms at 30Hz. iOS delivers nearer 30, so 0.04 is the match, and it
   * is what the measurements agree with. Feeding a stationary heading jittering
   * by +/-0.6 degrees, which is ordinary compass noise at rest:
   *
   *     tau     wobble sd   frame-to-frame
   *     0         0.323°       0.291°
   *     0.02      0.296°       0.255°
   *     0.04      0.244°       0.204°
   *
   * Note how little 0.02 buys. A first-order filter with a 20 ms constant barely
   * touches noise arriving at 30Hz — which is why the earlier "0.02 is the
   * corner" reasoning was wrong: it was derived from a synthetic pan with no
   * noise in it, so it could only ever measure lag, never this.
   *
   * 0 is available and is genuinely lag-free, if raw sensor noise is ever
   * preferable to a degree or two of lag. That is the setting AR.js issue #278
   * reports as the fix; see `rotationFilter` for why it is not the default.
   *
   * Only the 'fixed' filter reads this, and 'euro' is now the default — so
   * passing ?smoothrot= selects 'fixed' as well as setting the constant, or
   * the value would be silently ignored.
   */
  orientationSmoothing: num('smoothrot', 0.04),

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
   * 68 would be the iPhone main wide camera: 26 mm equivalent is 2·atan(18/26),
   * about 69° across the long axis. Ultra-wide is nearer 100, the 2x nearer 37.
   * `?vfov=` forces an exact vertical value and wins over this.
   *
   * Defaults to 0 — off — even though the value it would replace is wrong. A
   * correct fov is not free: it is narrower, and a narrower fov spreads the same
   * angular error over more pixels. Over 896 px, 173° gives 5.2 px per degree
   * and 53.7° gives 16.7, so every bit of compass noise and every millisecond of
   * latency becomes 3.2 times more visible. Judged on the phone, that read as
   * markedly worse — laggier and jitterier — even though the geometry was right
   * and the drift it fixes is real.
   *
   * That trade is worth understanding before turning it on. The registration
   * error the wide fov causes is invisible here: the aircraft is a kilometre
   * away, flying, with nothing behind it to line up against, so nobody can tell
   * it sits a couple of hundred pixels from where GPS says. The tracking error
   * the narrow fov reveals is not invisible at all. Being wrong in a way no one
   * can see beats being right in a way everyone can.
   *
   * Worth knowing if it is ever revisited: with the correction off, LocAR's own
   * fov is not stable either — it recomputes on resize and was measured moving
   * between 173° and 60°, so the world's scale shifts when the browser toolbar
   * appears. `?vfov=120` buys back the forgiving wide view *and* pins it, which
   * is the better version of leaving this off.
   */
  lensFov: Math.max(0, num('lens', 0)),

  /**
   * Which filter smooths the rotation. 'fixed' (default) or 'euro'.
   *
   * 'fixed' is `orientationSmoothing` above: one time constant, all the time,
   * which forces a choice between wobble at rest and lag while panning.
   *
   * 'euro' is the 1€ filter (Casiez, Roussel & Vogel, CHI 2012): the same
   * first-order low-pass, but with a cutoff that rises with the signal's own
   * speed. The two complaints never coincide — holding still there is no motion
   * to lag, so smoothing is free; panning, real movement swamps the noise, so
   * smoothing buys nothing and only costs lag — so an adaptive cutoff can beat
   * a fixed one at both ends rather than trading them.
   *
   * It only varies how hard it smooths. It never extrapolates, which is the
   * difference between this and the ?predict= attempt that was reverted for
   * being unusable: that differentiated the readings to guess ahead, and
   * differentiating noise amplifies it.
   */
  /**
   * Render the world as the camera feed saw it, rather than as the sensor sees
   * it now — ?feedmatch=1.
   *
   * The aircraft is drawn from a live orientation sensor over a background that
   * is tens of milliseconds old, so while panning the aircraft leads the
   * scenery. That is the "it follows the camera for a bit" report, and no
   * rotation-filter setting removes it: the filter can only add lag, and the
   * amount needed is a property of the phone's camera pipeline.
   *
   * With this on, requestVideoFrameCallback is asked how old each displayed
   * frame is (expectedDisplayTime - captureTime, both on performance.now()'s
   * clock) and the render is held back by exactly that. Supported in Safari
   * since 15.4; a device that reports no capture time falls back to the
   * shipped behaviour rather than to a guess.
   *
   * On by default. It measures rather than guesses, and where it cannot measure
   * it applies nothing at all — so a device reporting no capture time gets
   * exactly the behaviour that shipped before this. `rotationFilter` is coupled
   * to it for the same reason.
   */
  feedMatch: flag('feedmatch', true),

  /**
   * Hold the render back by a fixed number of SECONDS instead of measuring —
   * ?feedlag=0.08. Takes precedence over feedmatch, and is the way to check a
   * suspected latency by hand, or to pin a known-good figure for a known phone.
   */
  feedLag: Math.max(0, num('feedlag', 0)),

  /*
   * 'auto': the 1€ filter when the camera feed's delay is being cancelled, the
   * plain time constant when it is not. ?filter=fixed or ?filter=euro forces
   * either, and ?smoothrot= implies 'fixed' since that knob only means anything
   * to that filter.
   *
   * The coupling is the whole point, and it took two wrong defaults to find.
   *
   * An earlier attempt made 'euro' unconditional, on the strength of the AR.js
   * #278 workaround (`smoothingFactor: 1` — turn the smoothing off, because the
   * smoothing IS the lag). Every figure behind that compared the model against
   * the TRUE heading. What a person compares it against is the CAMERA FEED,
   * which is tens of milliseconds behind reality: panning, the background shows
   * where the phone was pointing a moment ago while the model is drawn from
   * where it points now, so the model LEADS the background. It reads exactly
   * like sticking to the camera, but it is the opposite sign to smoothing lag —
   * so cutting the filter's lag makes it worse, and 'euro' measured worse than
   * the default it replaced.
   *
   * Once `feedMatch` holds the render back by the feed's measured age, the sign
   * flips. The delay is now supplied deliberately, so any lag the filter adds
   * on top overshoots, and a filter that stays out of the way while panning is
   * exactly what is wanted. Against a feed 80 ms behind, medians of repeated
   * runs (FEED_LATENCY_MS=80 node tools/rotation-vis.mjs):
   *
   *                                        slide     twitch at rest
   *     fixed 0.04, no matching            3.36        0.18
   *     matching + fixed 0.04              1.47         --
   *     matching + euro beta 35            0.95        0.17
   *     matching + no smoothing at all     0.48        0.23
   *
   * About four times steadier while panning at no cost at rest — the first
   * setting that beats the approved build on the complaint without trading
   * against the other one. No smoothing at all is steadier still while panning,
   * but it hands the raw compass through and pays for it at rest.
   *
   * 'auto' rather than plain 'euro' because feed matching can measure nothing on
   * a browser that reports no frame capture time. There, no delay is applied,
   * so 'euro' would be the version that measured WORSE — falling back to
   * 'fixed' means such a device gets precisely what shipped before.
   */
  rotationFilter: (() => {
    const asked = params.get('filter');
    if (asked === 'euro' || asked === 'fixed') return asked;
    if (params.has('smoothrot')) return 'fixed';
    return 'auto';
  })(),

  /**
   * 1€ filter, minimum cutoff in Hz — what it does when you hold still.
   *
   * Lower is smoother. 1.0 Hz is about a 0.16 s time constant at 60fps, four
   * times calmer than the fixed filter's 0.04 — which at rest costs nothing,
   * because there is no motion to lag behind.
   */
  euroMinCutoff: Math.max(0.01, num('fcmin', 1.0)),

  /**
   * 1€ filter, speed coefficient — how fast it gets out of the way, per rad/s.
   *
   * Higher means less lag while panning, at the cost of letting more noise
   * through while panning. 20 was tried first and was too aggressive: measured
   * against noisy readings it cut the lag to 0.35° but pushed the shake while
   * panning to 1.27°, worse than the fixed filter manages. 5 is the setting
   * that keeps the win at rest without paying for it in motion.
   *
   * Measured against noisy readings, median of three runs, jitter as the
   * standard deviation of the per-frame step:
   *
   *                       still jitter   pan jitter   pan lag
   *     fixed 0.04           0.164°        0.905°      1.33°
   *     fixed 0.08           0.078°        0.588°      3.62°
   *     euro b5 fc1.0        0.060°        1.004°      1.49°
   *
   * Read that honestly: this does not beat the fixed filter everywhere, which
   * is what was claimed for it before it was measured. It is much the calmest
   * of the three when the phone is still — the worst single frame step falls
   * from 0.60° to 0.25° — and while panning it is a shade worse than the
   * current default on both counts. fixed 0.08 has the steadiest pan of the
   * three, but 3.6° of lag is the drift that was complained about earlier.
   */
  /*
   * 35. beta sets how fast the cutoff opens as the view turns, so it decides
   * how little lag the filter adds while panning — which is what matters now
   * that the feed's delay is supplied deliberately and anything the filter adds
   * on top overshoots. Swept against a noisy 60 deg/s pan, medians of three:
   *
   *              lag vs the sensor   twitch at rest
   *     beta   5       1.57 deg          0.137 deg
   *     beta  20       0.50             0.213
   *     beta  35       0.28             0.234
   *     beta  60       0.18             0.334
   *     beta 120       0.10             0.299
   *
   * At 5 — the value this shipped with — it smoothed so hard while panning that
   * it had MORE lag than the plain filter it was meant to improve on. Past 35
   * the cutoff starts opening on the sensor's noise rather than on real
   * movement, so the twitch climbs. 35 is the knee.
   */
  euroBeta: Math.max(0, num('beta', 35)),

  /** Go fullscreen on start where the browser allows it (not iPhone Safari). */
  fullscreen: flag('fullscreen', true),
};
