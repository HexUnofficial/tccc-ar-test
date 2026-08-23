/**
 * ── GPS, DEMOTED ──────────────────────────────────────────────────────────
 *
 * 8th Wall does not do geolocation, and it should not: its job is the camera
 * pose. So the fixes come straight from `navigator.geolocation`, the same place
 * LocAR got them, and what has changed is what they are used for.
 *
 * In the LocAR build a fix was a command — it moved the camera, and therefore
 * moved the world relative to you, and therefore had to be averaged over three
 * readings and then eased into over a whole GPS interval to stop the scene
 * lurching about while you stood still. All of that machinery existed to hide
 * the fact that the wrong thing was being driven.
 *
 * Here a fix is evidence. The first good one places the world; after that it is
 * only compared against SLAM, and by default changes nothing (see georef's
 * `geoLock`). Nothing needs averaging, because nothing downstream of it moves.
 */

/**
 * @param {object} options
 * @param {number} options.minAccuracy  ignore fixes worse than this, in metres
 * @param {(fix: {lat:number, lon:number, accuracy:number, at:number}) => void} options.onFix
 * @param {(message: string, code: number) => void} [options.onError]
 * @returns {{stop: () => void}}
 */
export function watchGps({ minAccuracy, onFix, onError }) {
  if (!navigator.geolocation) {
    onError?.('This browser has no geolocation.', 2);
    return { stop() {} };
  }

  const id = navigator.geolocation.watchPosition(
    ({ coords, timestamp }) => {
      /*
       * A rejected fix is not an error. Indoors and among tall buildings the
       * first several readings routinely come back at ±80 m or worse, and
       * reporting each one as a failure would bury the real message — which is
       * that we are still waiting for something good enough to place a
       * kilometre-distant aircraft against.
       */
      if (Number.isFinite(coords.accuracy) && coords.accuracy > minAccuracy) return;
      onFix({
        lat: coords.latitude,
        lon: coords.longitude,
        accuracy: coords.accuracy ?? Number.NaN,
        at: timestamp,
      });
    },
    (error) => {
      onError?.(
        error.code === 1
          ? 'Location permission denied — allow it and reload.'
          : `Lost GPS${error.message ? `: ${error.message}` : ''}. Waiting for a fix…`,
        error.code,
      );
    },
    {
      enableHighAccuracy: true,
      // No maximumAge: a cached fix from a different part of town would place
      // the world wrongly and then be corrected, which is worse than waiting.
      maximumAge: 0,
      timeout: 30_000,
    },
  );

  return {
    stop() {
      navigator.geolocation.clearWatch(id);
    },
  };
}
