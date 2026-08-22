/**
 * ── WHERE THE MODEL GOES ──────────────────────────────────────────────────
 *
 * To get coordinates: open Google Maps, right-click the exact spot, and click
 * the "lat, lon" pair at the top of the menu to copy it. Paste it below.
 * Decimal degrees, north and east positive. Six decimal places is ~10 cm —
 * more precision than GPS can resolve, so don't agonise over it.
 */
export const INSTALLATION = {
  // Set from the map picker: on the Thames, with the run following the river
  // east on a bearing of 95.8°. `label` only ever appeared in the HUD's "you
  // are N m from X" warning, and the default UI no longer shows that warning
  // at all (see config.js `ui`), so it is inert unless you turn the HUD back
  // on with ?debug=1.
  label: 'Set me',
  lat: 51.5108394,
  lon: -0.0946055,
  /**
   * Metres above the viewer's feet. Leave at 0 for something standing on the
   * ground with you; raise it to put the model on a roof or a plinth.
   */
  elevation: 0,
};

/**
 * 'relative' ignores INSTALLATION and drops the model a fixed distance from
 * wherever you happen to be standing, so the experience works in any car park.
 * 'fixed' pins it to INSTALLATION, which is what you deploy.
 *
 * Either can be forced per-visit with ?mode=fixed or ?mode=relative.
 */
export const DEFAULT_MODE = 'fixed';

/**
 * Lock the placement for production.
 *
 * Every setting in this project can be overridden from the query string, which
 * is what makes it tunable in the field — and also means anyone can drag the
 * aircraft somewhere else by editing the URL. With this true, the parameters
 * that decide *where* the experience is (lat, lon, mode, heading, elev) are
 * ignored, and only the harmless presentation ones still work.
 */
export const LOCKED = false;

/**
 * Which way the aircraft beats back and forth.
 *
 *   'across'  perpendicular to your line of sight, so it sweeps left and right
 *             in front of you wherever you stand. Best for testing.
 *   'along'   straight towards you and away again.
 *   a number  a true compass bearing, held regardless of where you stand.
 *             This is the one to set on site: point it down the river.
 *
 * The Thames runs roughly WSW-ENE through central London, but its bearing
 * changes sharply along its length, so measure it at the spot you're using:
 * drop two Google Maps pins along the stretch you want and take the bearing
 * between them.
 */
export const FLIGHT_HEADING = 95.8;

/** Relative-mode placement: how far away, and on what compass bearing. */
export const RELATIVE_PLACEMENT = {
  distance: 20, // metres
  bearing: 0, // degrees from true north; 0 = due north, 90 = east
};

/**
 * The circuit as flown at this installation, and how big the aircraft is on it.
 *
 * These live here rather than in config.js so that the map picker's "Ship it"
 * snippet can set them: everything you tune on that page now lands in one
 * paste. config.js still owns the defaults for anything not listed here, and
 * every value stays overridable from the query string for field testing.
 *
 *   length  metres of straight leg, or the string 'fit' to size it to the
 *           frame at the anchor's range
 *   size    overall length of the whole assembly — aircraft, tow line and
 *           banner — in metres. null defers to the per-model figure in
 *           models.js, which is what you want for anything but the aircraft.
 */
/*
 * Set from the map picker, as shown on screen.
 *
 * turnRadius is deliberately 20 m against advice, so that it is not mistaken
 * for an oversight later: at 60 m/s a 20 m turn needs an 87 degree bank, which
 * the 45 degree clamp in config.js cuts to a hard snap lasting about a second.
 * It also puts the two legs 40 m apart while the assembly is 400 m long, so
 * the banner is still outbound while the nose is already heading back and the
 * model passes through itself at each end. Widening this to ~367 m — the
 * radius a 60 m/s aircraft actually holds at 45 degrees — fixes both.
 */
export const FLIGHT = {
  length: 2027,
  turnRadius: 20,
  altitude: 50,
  speed: 60,
  size: 400,
};
