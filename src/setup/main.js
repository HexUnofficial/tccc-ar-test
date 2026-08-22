import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import QRCode from 'qrcode';
import { createFlightPath } from '../flight.js';
import { bearingBetween, destination, distanceBetween } from '../geo.js';
import { INSTALLATION, FLIGHT_HEADING } from '../location.js';
import { DEFAULT_MODEL, MODELS } from '../models.js';

/**
 * Authoring tool for placing the flight circuit on a map.
 *
 * Two things have to be decided on a map and can't sensibly be typed: the exact
 * stretch of water, and its bearing. A postcode gives you neither.
 *
 * So the two pins are the two *ends of the run* — the aircraft beats back and
 * forth between them. Everything the AR page needs falls out of that pair: the
 * anchor is their midpoint, the heading is the bearing from A to B, and the leg
 * length is the distance between them.
 *
 * The outline drawn on the map is sampled from the real `createFlightPath`, not
 * an approximation of it, so what you see here is what will actually fly.
 * Excluded from the production build; see vite.config.js.
 */

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const num = (key, fallback) => {
  const value = Number.parseFloat(params.get(key));
  return Number.isFinite(value) ? value : fallback;
};

const startHeading = num(
  'heading',
  Number.isFinite(Number(FLIGHT_HEADING)) ? Number(FLIGHT_HEADING) : 90,
);
const startLength = num('length', 250);
const startCentre = { lat: num('lat', INSTALLATION.lat), lon: num('lon', INSTALLATION.lon) };

/** The two ends of the run. Heading, length and anchor are all derived. */
const state = {
  a: destination(startCentre, (startHeading + 180) % 360, startLength / 2),
  b: destination(startCentre, startHeading, startLength / 2),
  turnRadius: num('turn', 40),
  altitude: num('alt', 50),
  speed: num('speed', 20),
  /** Length of the whole assembly — aircraft, tow line and banner — in metres. */
  size: num('size', MODELS[DEFAULT_MODEL].size),
  /** Not sent to the AR page; only used to predict how big it will look. */
  viewer: num('viewer', 200),
};

/**
 * Roughly how tall the aircraft will be on a phone screen.
 *
 * Assumes about 60 degrees of vertical field of view over 850 pixels, which is
 * typical for a portrait phone. Approximate on purpose — the point is to answer
 * "is it going to be a speck?" before walking to the river, not to be exact.
 */
function apparentPixels(metres, distance) {
  const angle = 2 * Math.atan(metres / 2 / Math.max(distance, 1)) * (180 / Math.PI);
  return { angle, pixels: (angle / 60) * 850 };
}

const runLength = () => distanceBetween(state.a, state.b);
const runHeading = () => bearingBetween(state.a, state.b);
const runCentre = () => destination(state.a, runHeading(), runLength() / 2);

/** Same config as the emitted URL, but with simulated GPS for desktop use. */
let previewUrl = '';

// ── Map ──────────────────────────────────────────────────────────────────────

const map = L.map('map', { zoomControl: true }).setView([startCentre.lat, startCentre.lon], 16);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const pin = (colour, letter) => L.divIcon({
  className: '',
  html: `<div style="width:22px;height:22px;border-radius:50%;background:${colour};
    border:2px solid #0d1117;display:grid;place-items:center;color:#0d1117;
    font:600 11px system-ui">${letter}</div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const startPin = L.marker([state.a.lat, state.a.lon], {
  draggable: true, icon: pin('#f0883e', 'A'), zIndexOffset: 1000,
}).addTo(map);

const endPin = L.marker([state.b.lat, state.b.lon], {
  draggable: true, icon: pin('#3fb950', 'B'), zIndexOffset: 900,
}).addTo(map);

const runLine = L.polyline([], { color: '#3fb950', weight: 1.5, dashArray: '5 6', opacity: 0.8 }).addTo(map);
const circuit = L.polyline([], { color: '#58a6ff', weight: 2.5, opacity: 0.95 }).addTo(map);

/** Convert the flight path's local metres (east = +x, north = -z) to lat/lon. */
function toLatLon(centre, x, z) {
  return destination(destination(centre, 0, -z), 90, x);
}

function circuitOutline() {
  const centre = runCentre();
  const path = createFlightPath({
    shape: 'racetrack',
    heading: runHeading(),
    length: runLength(),
    turnRadius: state.turnRadius,
    altitude: state.altitude,
    speed: state.speed,
    maxBank: Math.PI / 4,
    rollTime: 0,
  });
  const points = [];
  const steps = 160;
  for (let i = 0; i <= steps; i += 1) {
    const p = path.positionAt((path.lapTime * i) / steps);
    const { lat, lon } = toLatLon(centre, p.x, p.z);
    points.push([lat, lon]);
  }
  return { points, lapTime: path.lapTime, perimeter: path.perimeter };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  const heading = runHeading();
  const length = runLength();
  const centre = runCentre();
  const { points, lapTime, perimeter } = circuitOutline();

  circuit.setLatLngs(points);
  runLine.setLatLngs([[state.a.lat, state.a.lon], [state.b.lat, state.b.lon]]);

  el('r-anchor').textContent = `${centre.lat.toFixed(7)}, ${centre.lon.toFixed(7)}`;
  el('r-heading').textContent = `${heading.toFixed(1)}°`;
  el('r-length').textContent = `${length.toFixed(0)} m`;
  el('r-apart').textContent = `${(state.turnRadius * 2).toFixed(0)} m`;
  // The bundled aircraft is about a third wingspan to overall length.
  el('r-span').textContent = `${(state.size * 0.36).toFixed(0)} m`;
  el('r-lap').textContent = `${perimeter.toFixed(0)} m · ${lapTime.toFixed(0)}s`;

  el('length').value = String(Math.round(length));
  el('v-length').textContent = `${length.toFixed(0)} m`;
  el('v-turn').textContent = `${state.turnRadius} m`;
  el('v-alt').textContent = `${state.altitude} m`;
  el('v-speed').textContent = `${state.speed} m/s`;
  el('v-size').textContent = `${state.size} m`;
  el('v-viewer').textContent = `${state.viewer} m`;

  const whole = apparentPixels(state.size, state.viewer);
  // The banner is roughly a fifth of the assembly's length in height, and it is
  // the part that has to be legible.
  const banner = apparentPixels(state.size * 0.2, state.viewer);
  el('apparent').innerHTML = `From ${state.viewer} m the aircraft spans about `
    + `<b>${whole.pixels.toFixed(0)} px</b> (${whole.angle.toFixed(1)}°), and the banner `
    + `stands about <b>${banner.pixels.toFixed(0)} px</b> tall. `
    + (banner.pixels < 20
      ? 'Lettering will not be readable at that size.'
      : 'Large lettering should read.');

  const query = new URLSearchParams({
    mode: 'fixed',
    lat: centre.lat.toFixed(7),
    lon: centre.lon.toFixed(7),
    heading: heading.toFixed(1),
    length: length.toFixed(0),
    turn: String(state.turnRadius),
    alt: String(state.altitude),
    speed: String(state.speed),
    size: String(state.size),
    debug: '1',
  });
  /*
   * Resolve against the containing directory rather than string-stripping
   * "setup.html": the dev server also serves this page at /setup, where the
   * strip silently fails and every emitted link points back here instead of at
   * the AR page. new URL('.') drops the last segment whatever it is called.
   */
  const base = new URL('.', location.href).href;
  const url = `${base}?${query}`;
  el('url').value = url;
  el('open-ar').href = url;

  /*
   * The desktop preview needs a viewpoint. Standing at the anchor puts you
   * inside the circuit, so back off perpendicular to the run — far enough to
   * see the whole of it, which is how it will be watched from a riverbank.
   */
  const standOff = Math.max(120, length * 0.8);
  const preview = new URLSearchParams(query);
  preview.set('sim', '1');
  preview.set('distance', standOff.toFixed(0));
  preview.set('viewfrom', ((heading + 90) % 360).toFixed(0));
  previewUrl = `${base}?${preview}`;
  el('preview').href = previewUrl;

  /*
   * A QR pointing at localhost is useless: scanned on a phone it resolves to
   * the phone. Say so rather than letting it fail mysteriously.
   */
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  el('qr-warning').hidden = !local;
  el('qr-note').hidden = local;

  QRCode.toCanvas(el('qr'), url, { width: 104, margin: 0 }).catch(() => {});

  el('snippet').value = [
    'export const INSTALLATION = {',
    "  label: 'Set me',",
    `  lat: ${centre.lat.toFixed(7)},`,
    `  lon: ${centre.lon.toFixed(7)},`,
    '  elevation: 0,',
    '};',
    '',
    "export const DEFAULT_MODE = 'fixed';",
    `export const FLIGHT_HEADING = ${heading.toFixed(1)};`,
    '',
    '// flight defaults in src/config.js, and size in src/models.js —',
    '// or leave these as URL overrides:',
    `//   length ${length.toFixed(0)}, turn ${state.turnRadius}, `
      + `alt ${state.altitude}, speed ${state.speed}, size ${state.size}`,
  ].join('\n');
}

// ── Interaction ──────────────────────────────────────────────────────────────

// Either pin can be dragged; the run is simply the line between them.
startPin.on('drag', () => {
  const { lat, lng } = startPin.getLatLng();
  state.a = { lat, lon: lng };
  render();
});
endPin.on('drag', () => {
  const { lat, lng } = endPin.getLatLng();
  state.b = { lat, lon: lng };
  render();
});

// The length slider walks B along the current bearing, leaving A where it is.
el('length').addEventListener('input', (event) => {
  state.b = destination(state.a, runHeading(), Number(event.target.value));
  endPin.setLatLng([state.b.lat, state.b.lon]);
  render();
});

for (const [id, key] of [['turn', 'turnRadius'], ['alt', 'altitude'], ['speed', 'speed'],
  ['size', 'size'], ['viewer', 'viewer']]) {
  const input = el(id);
  input.value = String(state[key]);
  input.addEventListener('input', () => {
    state[key] = Number(input.value);
    render();
  });
}

// Recentre the whole run on a pasted coordinate, keeping its length and bearing.
el('jump').addEventListener('change', (event) => {
  const match = event.target.value.match(/(-?[0-9]+(?:[.][0-9]+)?)\s*,\s*(-?[0-9]+(?:[.][0-9]+)?)/);
  if (!match) return;
  centreOn(Number(match[1]), Number(match[2]), 15);
});

/** Recentre the run on a point, keeping its length and bearing. */
function centreOn(lat, lon, zoom) {
  const heading = runHeading();
  const half = runLength() / 2;
  state.a = destination({ lat, lon }, (heading + 180) % 360, half);
  state.b = destination({ lat, lon }, heading, half);
  startPin.setLatLng([state.a.lat, state.a.lon]);
  endPin.setLatLng([state.b.lat, state.b.lon]);
  map.setView([lat, lon], Math.max(map.getZoom(), zoom));
  render();
}

/*
 * Saves looking your own coordinates up. Worth the warning though: on a laptop
 * this is derived from the network and can be a kilometre out, so it is a way
 * to get the map roughly to the right place, not to set a final anchor.
 */
el('locate').addEventListener('click', () => {
  const status = el('locate-status');
  if (!navigator.geolocation) {
    status.textContent = 'This browser has no geolocation.';
    return;
  }
  status.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      centreOn(coords.latitude, coords.longitude, 16);
      /*
       * Lead with the accuracy, not the coordinates. The fix itself is exact to
       * within a centimetre by the time it reaches the URL; what makes "use my
       * location" land in the wrong place is the reading, and on anything
       * without a GPS chip that is a WiFi or IP lookup that can be a kilometre
       * out. The number people need to see is the plus-or-minus.
       */
      const accuracy = coords.accuracy;
      const quality = accuracy <= 25 ? 'ok' : accuracy <= 150 ? 'rough' : 'bad';
      const status = el('locate-status');
      status.dataset.quality = quality;
      status.innerHTML = `<b>±${accuracy.toFixed(0)} m</b> — `
        + `${coords.latitude.toFixed(7)}, ${coords.longitude.toFixed(7)}`
        + (quality === 'ok'
          ? ''
          : quality === 'rough'
            ? '<br>Too coarse to anchor with. Drag the pins to the real spot.'
            : '<br>This is a network lookup, not GPS, and may be nowhere near you. '
              + 'Open this page on a phone for a real fix, or drag the pins.');
    },
    (error) => {
      status.textContent = error.code === error.PERMISSION_DENIED
        ? 'Location permission denied.'
        : `Could not get a location: ${error.message}`;
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
  );
});

const copy = (button, source) => button.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el(source).value);
  const original = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1200);
});
copy(el('copy-url'), 'url');
copy(el('copy-snippet'), 'snippet');

// "Preview here" and "Open for real" are anchors whose hrefs render() keeps in
// step with the sliders; there is no click handler to attach.

render();

// Exposed for the smoke test.
window.__setup = {
  state,
  render,
  map,
  get heading() { return runHeading(); },
  get length() { return runLength(); },
  get centre() { return runCentre(); },
  get outline() { return circuitOutline(); },
  get previewUrl() { return previewUrl; },
};
