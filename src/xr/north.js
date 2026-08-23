/**
 * Tying SLAM's arbitrary yaw to true north.
 *
 * SLAM gives a steady, camera-synchronised pose in a frame whose yaw is
 * whatever the session happened to start at. The compass gives an absolutely
 * referenced bearing that is noisy and only good to about ±10°. Neither is
 * usable alone: content placed by GPS needs true north, and a view driven by
 * the compass jitters.
 *
 * These two functions are the whole of that join, kept apart from the engine so
 * they can be checked exactly. Both were wrong in ways that a rendered scene
 * hid and a direct test caught in seconds.
 */

/** Shortest signed difference between two bearings, in degrees. */
export function bearingDelta(to, from) {
  let delta = to - from;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

/**
 * The yaw a north-up world needs so the camera reads `compassBearing`.
 *
 * A yaw of `a` maps a north-up bearing b onto scene bearing b - a. The camera
 * belongs to the scene, not to the world, so its scene bearing is given; for
 * the direction it looks along to have true bearing `compassBearing`, the world
 * must be turned by the difference.
 *
 * The trap, and the original bug: do NOT subtract the world's current yaw from
 * the camera's scene bearing first. The camera's bearing does not depend on the
 * world, so doing so makes the answer a function of itself and it converges on
 * exactly half — a 90° compass change turned the world 45°.
 */
export function northYaw(sceneBearing, compassBearing) {
  return bearingDelta(compassBearing - sceneBearing, 0);
}

/**
 * Ease `current` towards `target` over a time constant, the short way round.
 *
 * Frame-rate independent, so the feel does not change with the device. Angles
 * are wrapped, so easing from 170° to -170° crosses 20° of arc rather than 340°
 * — the difference between a nudge and the world spinning most of the way
 * around.
 *
 * @param tau seconds; 0 or less snaps.
 */
export function easeBearing(current, target, dt, tau) {
  const delta = bearingDelta(target, current);
  if (!(tau > 0) || !(dt > 0)) return current + delta;
  return current + delta * (1 - Math.exp(-dt / tau));
}
