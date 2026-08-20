/**
 * ── WHERE THE MODEL GOES ──────────────────────────────────────────────────
 *
 * To get coordinates: open Google Maps, right-click the exact spot, and click
 * the "lat, lon" pair at the top of the menu to copy it. Paste it below.
 * Decimal degrees, north and east positive. Six decimal places is ~10 cm —
 * more precision than GPS can resolve, so don't agonise over it.
 */
export const INSTALLATION = {
  // 174 St John St, London EC1V 4DE — 51°31'27.6"N 0°06'09.8"W
  label: '174 St John Street, London',
  lat: 51.524333,
  lon: -0.102722,
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

/** Relative-mode placement: how far away, and on what compass bearing. */
export const RELATIVE_PLACEMENT = {
  distance: 20, // metres
  bearing: 0, // degrees from true north; 0 = due north, 90 = east
};
