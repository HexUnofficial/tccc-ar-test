import { compassPoint } from './geo.js';

const el = (id) => document.getElementById(id);

/** Metres under a kilometre, kilometres above it. */
export const formatDistance = (metres) =>
  metres < 1000 ? `${metres.toFixed(1)} m` : `${(metres / 1000).toFixed(2)} km`;

/**
 * The on-screen overlay: a status pill, a telemetry panel, and a pointer arrow
 * that tells you which way to turn when the model is behind you. The arrow is
 * the difference between "the AR is broken" and "you're facing the wrong way".
 */
export function createHud() {
  const nodes = {
    status: el('status'),
    panel: el('panel'),
    arrow: el('arrow'),
    arrowGlyph: el('arrow').querySelector('svg'),
    arrowLabel: el('arrow-label'),
    fields: {},
  };

  for (const key of ['fix', 'accuracy', 'heading', 'distance', 'bearing', 'anchor', 'subject',
    'tracking', 'georef', 'fps']) {
    nodes.fields[key] = el(`f-${key}`);
  }

  const setField = (key, value) => {
    const node = nodes.fields[key];
    if (node && node.textContent !== value) node.textContent = value;
  };

  return {
    /** Idempotent: safe to call every frame with the same value. */
    setStatus(text, tone = 'neutral') {
      if (nodes.status.textContent === text && nodes.status.dataset.tone === tone) return;
      nodes.status.textContent = text;
      nodes.status.dataset.tone = tone;
      nodes.status.hidden = !text;
    },

    setPanelVisible(visible) {
      nodes.panel.hidden = !visible;
    },

    /** Hide the telemetry affordances entirely, leaving the arrow alone. */
    setChromeVisible(visible) {
      nodes.panel.hidden = !visible;
      el('panel-toggle').hidden = !visible;
    },

    /**
     * @param {object} state
     * @param {{lat:number, lon:number, accuracy:number}|null} state.position
     * @param {number|null} state.heading   compass heading of the device
     * @param {number|null} state.distance  metres to the anchor
     * @param {number|null} state.bearing   bearing to the anchor
     * @param {{lat:number, lon:number}|null} state.anchor
     * @param {{range:number, pixels:number}|null} state.subject
     * @param {{angle:number, range:number, onScreen:boolean}|null} state.pointer
     * @param {number} state.fps
     * @param {string} [state.tracking]  SLAM tracking status, XR8 engine only
     * @param {string} [state.georef]    world-frame yaw and GPS disagreement
     */
    update(state) {
      const {
        position, heading, distance, bearing, anchor, subject, pointer, fps, tracking, georef,
      } = state;

      setField('fix', position ? `${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}` : '—');
      // The XR8 engine derives the fix from SLAM, so there is a position even
      // before any GPS accuracy figure exists to report against it.
      setField('accuracy', Number.isFinite(position?.accuracy)
        ? `±${position.accuracy.toFixed(0)} m` : '—');
      setField('heading', heading == null ? '—' : `${heading.toFixed(0)}° ${compassPoint(heading)}`);
      setField('distance', distance == null ? '—' : formatDistance(distance));
      setField('bearing', bearing == null ? '—' : `${bearing.toFixed(0)}° ${compassPoint(bearing)}`);
      setField('anchor', anchor ? `${anchor.lat.toFixed(6)}, ${anchor.lon.toFixed(6)}` : '—');
      // How far the model actually is right now (it may be flying a circuit
      // well away from the anchor), and how big that leaves it on screen.
      setField('subject', subject
        ? `${formatDistance(subject.range)} · ${subject.pixels.toFixed(0)} px`
        : '—');
      /*
       * Two fields the LocAR build had no equivalent for, and the pair you read
       * when something looks wrong on site. `tracking` is whether SLAM has a
       * pose at all — LIMITED means it does not, and the world will drift until
       * it does. `georef` is the world frame's yaw and how far the last GPS fix
       * fell from where SLAM says you are: a residual of a few metres is normal
       * and ignored, one of hundreds means the compass lock was wrong.
       */
      setField('tracking', tracking ?? '—');
      setField('georef', georef ?? '—');
      setField('fps', `${fps.toFixed(0)}`);

      /*
       * The arrow tracks the model itself, not the anchor. For an aircraft
       * flying a 250 m circuit those are up to 165 m apart, so pointing at the
       * anchor sends you looking at empty sky. `pointer` is computed by
       * projecting the model into screen space, which also means the arrow
       * works vertically — the aircraft is often above the top of the frame.
       */
      if (!pointer) {
        nodes.arrow.hidden = true;
        return;
      }
      nodes.arrow.hidden = pointer.onScreen;
      if (!pointer.onScreen) {
        nodes.arrowGlyph.style.rotate = `${pointer.angle.toFixed(1)}deg`;
        nodes.arrowLabel.textContent = formatDistance(pointer.range);
      }
    },
  };
}
