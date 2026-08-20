import * as THREE from 'three';

const TAU = Math.PI * 2;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const GRAVITY = 9.81;

/**
 * A flight circuit around the anchor.
 *
 * The GLB's own clip is a gentle vertical bob that never leaves the spot. This
 * supplies the travel: the aircraft is flown along a path with its nose down
 * the velocity vector and its wings banked into each turn. The two layer
 * cleanly because the clip animates a node *inside* the model while this drives
 * the group the model sits in — so vertical motion stays the clip's job.
 *
 * The default shape is a racetrack: a long straight leg, a 180 at the end, and
 * a straight leg back. Aligned to a compass heading it reads as an aircraft
 * beating up and down a river, which a closed loop like a circle or a
 * figure-eight does not — those visibly double back through the middle.
 *
 * Paths are parametrised by distance travelled rather than by angle, so speed
 * is constant everywhere and is set in m/s rather than falling out of the
 * geometry.
 */
export function createFlightPath({
  shape, altitude, maxBank, speed, heading,
  length, turnRadius,      // racetrack
  radius, period,          // eight, circle
  rollTime,
}) {
  // Rotate the whole circuit onto its compass heading. LocAR's world has north
  // at -Z and east at +X, and the path is authored running along +X, so a
  // bearing of θ needs a yaw of 90° - θ.
  const headingYaw = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(90 - heading));

  const straight = Math.max(length, 0);
  const turnArc = Math.PI * turnRadius;
  const perimeter = 2 * straight + 2 * turnArc;

  /** Racetrack, parametrised by distance travelled around it. */
  function racetrackAt(distance, out) {
    const half = straight / 2;
    let d = ((distance % perimeter) + perimeter) % perimeter;

    if (d < straight) {
      return out.set(-half + d, altitude, turnRadius); // outbound leg
    }
    d -= straight;
    if (d < turnArc) {
      const a = d / turnRadius; // 0..PI around the far end
      return out.set(half + turnRadius * Math.sin(a), altitude, turnRadius * Math.cos(a));
    }
    d -= turnArc;
    if (d < straight) {
      return out.set(half - d, altitude, -turnRadius); // return leg
    }
    d -= straight;
    const a = d / turnRadius; // 0..PI around the near end
    return out.set(-half - turnRadius * Math.sin(a), altitude, -turnRadius * Math.cos(a));
  }

  function positionAt(t, out) {
    if (shape === 'racetrack') {
      racetrackAt(speed * t, out);
    } else {
      const angle = (TAU * t) / period;
      if (shape === 'circle') {
        out.set(radius * Math.cos(angle), altitude, radius * Math.sin(angle));
      } else {
        // Lemniscate of Gerono — a self-crossing loop, kept for comparison.
        out.set(radius * Math.cos(angle), altitude, radius * Math.sin(angle) * Math.cos(angle));
      }
    }
    return out.applyMatrix4(headingYaw);
  }

  const sample = new THREE.Vector3();
  const before = new THREE.Vector3();
  const after = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const acceleration = new THREE.Vector3();
  const lateral = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const rollQuat = new THREE.Quaternion();
  const rollAxis = new THREE.Vector3(0, 0, 1);

  // A racetrack's curvature jumps the instant the straight meets the turn. Real
  // aircraft take a moment to roll, so the bank is eased rather than snapped.
  let bank = 0;
  let lastTime = null;

  return {
    positionAt: (t) => positionAt(t, new THREE.Vector3()),
    perimeter,
    lapTime: shape === 'racetrack' ? perimeter / speed : period,

    /** Place and orient `object` for time `t` (seconds since the flight began). */
    apply(object, t) {
      const h = 0.02;
      positionAt(t, sample);
      positionAt(t - h, before);
      positionAt(t + h, after);

      velocity.subVectors(after, before).multiplyScalar(1 / (2 * h));
      acceleration.copy(after).add(before).addScaledVector(sample, -2).multiplyScalar(1 / (h * h));

      object.position.copy(sample);

      const rate = velocity.length();
      if (rate < 1e-6) return;
      forward.copy(velocity).divideScalar(rate);

      // Bank into the turn: the sideways component of acceleration balanced
      // against gravity is the angle a real aircraft would hold.
      right.crossVectors(forward, WORLD_UP).normalize();
      lateral.copy(acceleration).addScaledVector(forward, -acceleration.dot(forward));
      const target = THREE.MathUtils.clamp(
        Math.atan2(lateral.dot(right), GRAVITY),
        -maxBank,
        maxBank,
      );

      const dt = lastTime === null ? 0 : Math.min(Math.abs(t - lastTime), 0.25);
      lastTime = t;
      bank = rollTime > 0 && dt > 0
        ? bank + (target - bank) * (1 - Math.exp(-dt / rollTime))
        : target;

      // three.js objects look down -Z, so the basis puts -forward on Z.
      zAxis.copy(forward).negate();
      right.crossVectors(WORLD_UP, zAxis).normalize();
      up.crossVectors(zAxis, right);
      basis.makeBasis(right, up, zAxis);
      object.quaternion.setFromRotationMatrix(basis);

      // Then roll about the nose axis, which is local Z after that basis.
      rollQuat.setFromAxisAngle(rollAxis, bank);
      object.quaternion.multiply(rollQuat);
    },
  };
}
