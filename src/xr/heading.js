import * as THREE from 'three';

/**
 * ── THE COMPASS, USED ONCE ────────────────────────────────────────────────
 *
 * The LocAR build read the compass every frame and drew the world from it, so
 * compass noise was world jitter and compass lag was the world sliding under a
 * pan. That is the whole reason the previous engine needed a 1€ filter, a feed
 * latency estimator and four hundred lines of measurement to justify them.
 *
 * Here the compass is asked one question, once: which way is north. After the
 * georeference is locked, nothing in the running experience reads it again —
 * orientation comes from SLAM, which does not drift against the picture it is
 * drawn over because it is derived from that picture.
 *
 * That single reading still has to be right, so it is taken as a circular mean
 * of a second's worth of samples rather than whichever event happened to arrive
 * on the frame the user tapped.
 */

/**
 * The classic deviceorientation → quaternion construction, with the screen
 * rotation folded in. Straight out of three's (now removed)
 * DeviceOrientationControls: intrinsic Z-X'-Y'' for the device, then a -90°
 * X turn to put "screen facing you" at identity, then the screen orientation.
 *
 * Doing it properly matters because the naive shortcut — treat `alpha` as the
 * heading — is only true with the phone flat on a table. Held upright to look
 * through the camera, alpha describes a rotation about an axis pointing at the
 * sky, and the direction the lens faces has to be read off the full attitude.
 */
const ZEE = new THREE.Vector3(0, 0, 1);
const EULER = new THREE.Euler();
const Q0 = new THREE.Quaternion();
const Q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function deviceQuaternion(alpha, beta, gamma, screen, out) {
  EULER.set(beta, alpha, -gamma, 'YXZ');
  out.setFromEuler(EULER);
  out.multiply(Q1);
  out.multiply(Q0.setFromAxisAngle(ZEE, -screen));
  return out;
}

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/**
 * iOS 13+ only delivers deviceorientation after an explicit grant, inside a
 * user gesture. Requested by the gate rather than here, so there is one tap.
 */
export async function requestOrientationPermission() {
  const api = window.DeviceOrientationEvent;
  if (typeof api?.requestPermission !== 'function') return true; // Android, desktop
  try {
    return (await api.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Collects true-north bearings for the direction the camera is pointing.
 *
 * @returns {{start: () => void, stop: () => void, heading: number|null,
 *            samples: number, absolute: boolean}}
 */
export function createHeadingReader() {
  const quaternion = new THREE.Quaternion();
  const forward = new THREE.Vector3();

  /** Circular mean accumulators — bearings cannot be averaged arithmetically. */
  let sinSum = 0;
  let cosSum = 0;
  let samples = 0;
  let absolute = false;
  let listening = false;

  const screenAngle = () => rad(window.screen?.orientation?.angle ?? window.orientation ?? 0);

  function onOrientation(event) {
    /*
     * Two ways to get an absolute reference, and a phone that offers neither is
     * no use to us.
     *
     * iOS never sets `absolute` and never gives an absolute `alpha`, but it does
     * expose `webkitCompassHeading` in true degrees. Feeding `360 - heading` in
     * as alpha is the substitution AR.js and LocAR both make, and it lands the
     * quaternion in a north-referenced frame.
     *
     * Android sets `absolute: true` on `deviceorientationabsolute` and, on most
     * devices, on `deviceorientation` too. Where it does not, alpha is relative
     * to wherever the page happened to start and is worthless for this.
     */
    const compass = event.webkitCompassHeading;
    const hasCompass = Number.isFinite(compass);
    if (!hasCompass && !event.absolute) return;
    if (event.alpha === null || event.beta === null || event.gamma === null) return;

    const alpha = hasCompass ? 360 - compass : event.alpha;
    absolute = true;

    deviceQuaternion(rad(alpha), rad(event.beta), rad(event.gamma), screenAngle(), quaternion);
    forward.set(0, 0, -1).applyQuaternion(quaternion);

    /*
     * A phone pointed at the sky or the pavement has no meaningful heading: the
     * lens axis is near-vertical, so its horizontal projection is short and its
     * bearing is mostly noise. Discard those rather than let them drag the mean
     * — the aircraft is 10° above the horizon, so the useful poses are all
     * comfortably within this bound.
     */
    if (Math.abs(forward.y) > 0.94) return;

    const bearing = Math.atan2(forward.x, -forward.z);
    sinSum += Math.sin(bearing);
    cosSum += Math.cos(bearing);
    samples += 1;
  }

  return {
    start() {
      if (listening) return;
      listening = true;
      // Both, because coverage differs: Android fires `absolute` reliably, iOS
      // only fires the plain event and carries its truth in webkitCompassHeading.
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('deviceorientation', onOrientation, true);
    },

    stop() {
      if (!listening) return;
      listening = false;
      window.removeEventListener('deviceorientationabsolute', onOrientation, true);
      window.removeEventListener('deviceorientation', onOrientation, true);
    },

    /** Reset the accumulator, e.g. before a re-lock. */
    reset() {
      sinSum = 0;
      cosSum = 0;
      samples = 0;
    },

    /** Circular mean of everything seen so far, or null if nothing usable was. */
    get heading() {
      if (samples === 0) return null;
      return (deg(Math.atan2(sinSum, cosSum)) + 360) % 360;
    },

    /**
     * How tightly the samples agree, 0 to 1. Below about 0.9 the readings are
     * scattered enough that the mean is not worth trusting — usually an
     * uncalibrated Android magnetometer, or a phone next to something steel.
     */
    get confidence() {
      if (samples === 0) return 0;
      return Math.hypot(sinSum, cosSum) / samples;
    },

    get samples() { return samples; },
    /** False means no absolute reference was ever offered — no true north. */
    get absolute() { return absolute; },
  };
}
