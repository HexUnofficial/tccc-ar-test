import { compassPoint } from './geo.js';

const el = (id) => document.getElementById(id);

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

  for (const key of ['fix', 'accuracy', 'heading', 'distance', 'bearing', 'anchor', 'fps']) {
    nodes.fields[key] = el(`f-${key}`);
  }

  const setField = (key, value) => {
    const node = nodes.fields[key];
    if (node && node.textContent !== value) node.textContent = value;
  };

  return {
    setStatus(text, tone = 'neutral') {
      nodes.status.textContent = text;
      nodes.status.dataset.tone = tone;
      nodes.status.hidden = !text;
    },

    setPanelVisible(visible) {
      nodes.panel.hidden = !visible;
    },

    /**
     * @param {object} state
     * @param {{lat:number, lon:number, accuracy:number}|null} state.position
     * @param {number|null} state.heading   compass heading of the device
     * @param {number|null} state.distance  metres to the anchor
     * @param {number|null} state.bearing   bearing to the anchor
     * @param {{lat:number, lon:number}|null} state.anchor
     * @param {number} state.fps
     */
    update(state) {
      const { position, heading, distance, bearing, anchor, fps } = state;

      setField('fix', position ? `${position.lat.toFixed(6)}, ${position.lon.toFixed(6)}` : '—');
      setField('accuracy', position ? `±${position.accuracy.toFixed(0)} m` : '—');
      setField('heading', heading == null ? '—' : `${heading.toFixed(0)}° ${compassPoint(heading)}`);
      setField('distance', distance == null ? '—' : `${distance.toFixed(1)} m`);
      setField('bearing', bearing == null ? '—' : `${bearing.toFixed(0)}° ${compassPoint(bearing)}`);
      setField('anchor', anchor ? `${anchor.lat.toFixed(6)}, ${anchor.lon.toFixed(6)}` : '—');
      setField('fps', `${fps.toFixed(0)}`);

      // Point the arrow at the anchor, relative to where the device is facing.
      if (heading == null || bearing == null || distance == null) {
        nodes.arrow.hidden = true;
        return;
      }

      const relative = ((bearing - heading + 540) % 360) - 180;
      const onScreen = Math.abs(relative) < 30;
      nodes.arrow.hidden = onScreen;
      if (!onScreen) {
        nodes.arrowGlyph.style.rotate = `${relative}deg`;
        nodes.arrowLabel.textContent =
          `${distance < 1000 ? `${distance.toFixed(0)} m` : `${(distance / 1000).toFixed(1)} km`} ${relative > 0 ? 'right' : 'left'}`;
      }
    },
  };
}
