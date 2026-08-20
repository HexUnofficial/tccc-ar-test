import { MathUtils } from 'three';

const R = 6371008.8;

/**
 * A local tangent-plane projection, in true metres.
 *
 * LocAR defaults to spherical Mercator (EPSG:3857), whose "metres" are inflated
 * by sec(latitude): at 51°N an object placed 20 m away renders 31.9 m away, so
 * it reads far too small and distant. Mercator is the right choice for map
 * tiles and the wrong one for a scene measured in real-world metres.
 *
 * We anchor the scale to the first latitude we see — the AR session covers a
 * few hundred metres at most, over which the error is millimetres.
 */
export class LocalMetresProjection {
  #lat0 = null;
  #cosLat0 = 1;

  #anchor(lat) {
    if (this.#lat0 !== null) return;
    this.#lat0 = lat;
    this.#cosLat0 = Math.cos(MathUtils.degToRad(lat));
  }

  project = (lon, lat) => {
    this.#anchor(lat);
    return [
      MathUtils.degToRad(lon) * R * this.#cosLat0,
      MathUtils.degToRad(lat) * R,
    ];
  };

  unproject = ([easting, northing]) => [
    MathUtils.radToDeg(easting / (R * this.#cosLat0)),
    MathUtils.radToDeg(northing / R),
  ];

  getID = () => 'local-tangent-plane';
}
