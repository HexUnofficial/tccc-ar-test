/**
 * ── HOW OLD IS THE PICTURE? ────────────────────────────────────────────────
 *
 * The aircraft is drawn from an orientation sensor that is essentially live,
 * over a camera frame that took tens of milliseconds to reach the screen. While
 * panning, the model therefore leads the scenery it is supposed to be standing
 * in — which is what "it follows the camera for a bit" is. Cancelling it means
 * drawing from the orientation the phone had when the visible frame was
 * captured, and that needs a number: the feed's age.
 *
 * `requestVideoFrameCallback` will sometimes just tell us (`captureTime`), and
 * where it does, that is the cheapest answer. But it is not required to, and a
 * fix that quietly does nothing on the one handset that matters is no fix. So
 * this measures the same quantity from first principles instead, using only
 * pixels and the sensor:
 *
 *   1. Reduce each camera frame to a 1-D signature — one number per column, so
 *      a whole frame collapses to 64 values that survive noise and exposure
 *      changes but move when the scene pans.
 *   2. Estimate how far the image slid sideways between consecutive frames, by
 *      finding the shift that best lines the two signatures up.
 *   3. Correlate that series of image shifts against the sensor's own yaw rate,
 *      trying every plausible lag. The lag that lines them up best is how far
 *      the picture trails the sensor — which is exactly what we wanted.
 *
 * Panning right slides the image left, so the correlation being sought is
 * negative; a positive one means something other than a pan is moving the
 * picture and the estimate is thrown away.
 *
 * The two steps that do the arithmetic are exported separately and take plain
 * arrays, so they can be tested against synthetic signals of known lag rather
 * than only through a camera.
 */

/**
 * Best horizontal shift, in columns, that aligns `signature` onto `previous`.
 *
 * Plain sum of absolute differences over the overlapping region, normalised by
 * that region's width so a large shift is not favoured merely for comparing
 * fewer columns. Sub-pixel precision would be wasted here: only the timing of
 * this signal matters, not its scale.
 *
 * @returns {number|null} shift in columns, or null if nothing moved enough to
 *   tell — a static scene has no information about latency in it.
 */
export function estimateShift(previous, signature, maxShift = 10) {
  if (!previous || !signature || previous.length !== signature.length) return null;
  const n = signature.length;

  let energy = 0;
  for (let i = 1; i < n; i += 1) energy += Math.abs(signature[i] - signature[i - 1]);
  // A flat wall or a clear sky cannot be tracked, and pretending otherwise
  // feeds noise into the correlation.
  if (energy / n < 0.6) return null;

  let bestShift = 0;
  let bestCost = Infinity;
  for (let shift = -maxShift; shift <= maxShift; shift += 1) {
    let cost = 0;
    let counted = 0;
    for (let i = Math.max(0, -shift); i < Math.min(n, n - shift); i += 1) {
      cost += Math.abs(signature[i + shift] - previous[i]);
      counted += 1;
    }
    if (counted < n / 2) continue;
    const mean = cost / counted;
    if (mean < bestCost) { bestCost = mean; bestShift = shift; }
  }
  return bestShift;
}

/**
 * The lag, in samples, at which `image` best explains `sensor`.
 *
 * Both are same-length series sampled on the same clock, oldest first. Returns
 * the lag maximising the magnitude of a normalised cross-correlation, together
 * with that correlation so the caller can refuse a weak one.
 *
 * @param sensor  yaw rate per sample, from the orientation sensor
 * @param image   horizontal image shift per sample, from `estimateShift`
 */
export function estimateLag(sensor, image, maxLag) {
  if (sensor.length !== image.length || sensor.length < maxLag + 8) return null;

  const centred = (series) => {
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    return series.map((v) => v - mean);
  };

  const scores = [];
  for (let lag = 0; lag <= maxLag; lag += 1) {
    // The image at sample i reflects where the phone was pointing `lag` samples
    // ago, so compare image[i] against sensor[i - lag].
    const a = [];
    const b = [];
    for (let i = lag; i < sensor.length; i += 1) { a.push(sensor[i - lag]); b.push(image[i]); }
    const ca = centred(a);
    const cb = centred(b);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < ca.length; i += 1) { dot += ca[i] * cb[i]; na += ca[i] * ca[i]; nb += cb[i] * cb[i]; }
    if (na <= 0 || nb <= 0) continue;
    scores.push({ lag, correlation: dot / Math.sqrt(na * nb) });
  }
  if (scores.length === 0) return null;

  const best = scores.reduce((a, b) => (Math.abs(b.correlation) > Math.abs(a.correlation) ? b : a));

  /*
   * How distinct that peak is, ignoring its immediate neighbours.
   *
   * A smooth pan correlates well over a range of lags, so the peak is broad and
   * a single noisy window can pick a neighbour of the true answer — or, when
   * the signal is nearly periodic, an entirely wrong one. `rival` is the best
   * score at least three samples away, and the caller uses the gap between them
   * to decide whether this window is worth believing at all.
   */
  const rival = scores
    .filter((s) => Math.abs(s.lag - best.lag) >= 3)
    .reduce((a, b) => (Math.abs(b.correlation) > Math.abs(a.correlation) ? b : a), { lag: -1, correlation: 0 });

  return { ...best, distinctness: Math.abs(best.correlation) - Math.abs(rival.correlation) };
}

/**
 * Watches a <video> and an orientation source, and reports the feed's age.
 *
 * Sampling is deliberately coarse — a 64x36 draw and 64 sums per frame — because
 * this runs beside the render on a phone. The estimate is only replaced when a
 * correlation is both strong and of the expected sign, and it is eased rather
 * than snapped so a single bad window cannot swing the whole world.
 */
export function createFeedLagMeter({
  video, columns = 64, rows = 36, maxLagSeconds = 0.3, sampleHz = 60,
  minCorrelation = 0.55, minDistinctness = 0.02, keep = 7, onEstimate = null,
} = {}) {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (canvas) { canvas.width = columns; canvas.height = rows; }
  const context = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;

  const maxLagSamples = Math.round(maxLagSeconds * sampleHz);
  const window = maxLagSamples + 60;
  const sensorSeries = [];
  const imageSeries = [];
  let previousSignature = null;
  let sinceSample = 0;
  /*
   * Accepted estimates, newest last, reported as their median.
   *
   * An exponential chase was the obvious choice and the wrong one: it moves
   * towards every accepted window including a bad one, and a single confident
   * mistake drags the whole world with it for seconds. A median of recent
   * windows ignores an outlier completely.
   */
  const accepted = [];
  let lastCorrelation = 0;
  let lastDistinctness = 0;

  function signatureOf() {
    if (!context || !video || video.readyState < 2 || !video.videoWidth) return null;
    context.drawImage(video, 0, 0, columns, rows);
    const { data } = context.getImageData(0, 0, columns, rows);
    const sums = new Array(columns).fill(0);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const i = (y * columns + x) * 4;
        // Green alone: a fair proxy for luminance at a third of the reads.
        sums[x] += data[i + 1];
      }
    }
    for (let x = 0; x < columns; x += 1) sums[x] /= rows;
    return sums;
  }

  return {
    /** How far the picture trails the sensor, in seconds; null until confident. */
    get latencySeconds() {
      if (accepted.length < 3) return null;
      const sorted = [...accepted].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    },
    get correlation() { return lastCorrelation; },
    get distinctness() { return lastDistinctness; },
    get samples() { return imageSeries.length; },

    /**
     * @param dt           seconds since the previous call
     * @param yawRateDegPerSec  how fast the sensor says the view is turning
     */
    update(dt, yawRateDegPerSec) {
      if (!Number.isFinite(dt) || dt <= 0) return;
      sinceSample += dt;
      if (sinceSample < 1 / sampleHz) return;
      const step = sinceSample;
      sinceSample = 0;

      const signature = signatureOf();
      if (!signature) return;
      const shift = previousSignature ? estimateShift(previousSignature, signature) : null;
      previousSignature = signature;
      if (shift === null) return;

      sensorSeries.push(yawRateDegPerSec);
      imageSeries.push(shift / step);
      while (sensorSeries.length > window) { sensorSeries.shift(); imageSeries.shift(); }
      if (sensorSeries.length < maxLagSamples + 8) return;

      const found = estimateLag(sensorSeries, imageSeries, maxLagSamples);
      if (!found) return;
      lastCorrelation = found.correlation;
      lastDistinctness = found.distinctness;
      // Turning right slides the picture left. A positive correlation means
      // something other than a pan is moving the image — a passing car, the
      // aircraft itself — and says nothing about latency.
      if (found.correlation > -minCorrelation) return;
      // A peak no better than one several samples away is not a measurement.
      if (found.distinctness < minDistinctness) return;

      accepted.push(found.lag / sampleHz);
      while (accepted.length > keep) accepted.shift();
      onEstimate?.(this.latencySeconds, found.correlation);
    },
  };
}
