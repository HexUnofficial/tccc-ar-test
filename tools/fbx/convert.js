/**
 * FBX to GLB, run in a browser because three's FBXLoader needs a DOM.
 *
 * Served by the Vite dev server and driven by tools/fbx-to-glb.mjs; it is not a
 * build input, so it never reaches the bundle. Converting offline beats loading
 * FBX at runtime: the FBX loader is much heavier, the format is proprietary,
 * and it can't carry the compressed textures the GLB pipeline produces.
 */
import * as THREE from 'three';
window.THREE = THREE;
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

window.convert = async (url) => {
  const missing = [];
  THREE.DefaultLoadingManager.onError = (failed) => missing.push(failed.split('/').pop());

  const group = await new FBXLoader().loadAsync(url);

  const report = { meshes: 0, triangles: 0, materials: new Set(), textured: 0 };
  const box = new THREE.Box3();
  group.traverse((child) => {
    if (!child.isMesh) return;
    report.meshes += 1;
    const geometry = child.geometry;
    report.triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    for (const material of [].concat(child.material)) {
      if (!material) continue;
      report.materials.add(material.name || material.uuid);
      if (material.map) report.textured += 1;
    }
    box.expandByObject(child);
  });

  const size = new THREE.Vector3();
  box.getSize(size);

  /*
   * Any texture whose file 404'd is still attached to its material, but with no
   * image behind it — and GLTFExporter throws rather than skipping it. Drop the
   * empty ones so the geometry can still be exported; they come back
   * automatically once the texture files are present.
   */
  const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
    'aoMap', 'bumpMap', 'specularMap', 'alphaMap', 'displacementMap'];
  let stripped = 0;
  group.traverse((child) => {
    if (!child.isMesh) return;
    for (const material of [].concat(child.material)) {
      if (!material) continue;
      for (const slot of slots) {
        const texture = material[slot];
        if (texture && !(texture.image && texture.image.width)) {
          material[slot] = null;
          stripped += 1;
        }
      }
      material.needsUpdate = true;
    }
  });

  const glb = await new GLTFExporter().parseAsync(group, { binary: true });

  // Hand the bytes back through a download, which Playwright can capture
  // without serialising eight megabytes through the CDP bridge.
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  link.download = 'converted.glb';
  link.click();

  return {
    meshes: report.meshes,
    triangles: Math.round(report.triangles),
    materials: report.materials.size,
    texturedMaterials: report.textured,
    animations: group.animations.length,
    size: [size.x, size.y, size.z].map((n) => Number(n.toFixed(2))),
    bytes: glb.byteLength,
    missingTextures: [...new Set(missing)],
    strippedSlots: stripped,
  };
};

/** Render a GLB down three axes, so its orientation and scale can be checked. */
window.inspect = async (url, W, H, options = {}) => {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');

  const draco = new DRACOLoader().setDecoderPath(
    'https://www.gstatic.com/draco/versioned/decoders/1.5.7/',
  );
  const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(url);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 3));
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(1, 2, 1);
  scene.add(key, gltf.scene);

  /*
   * Untextured materials from an FBX come through nearly black, and this model
   * tows a banner three times its own length, so a bounding-box framing shrinks
   * the aircraft to a speck. Both make a perfectly good conversion look broken.
   */
  if (options.neutral) {
    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        child.material = new THREE.MeshStandardMaterial({
          color: 0xc8ccd4, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide,
        });
      }
    });
  }

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  let radius = size.length() / 2;
  // Optionally frame only the densest part — the aircraft, not the banner.
  if (options.framePart) {
    const parts = [];
    gltf.scene.traverse((child) => {
      if (!child.isMesh) return;
      const b = new THREE.Box3().setFromObject(child);
      const s = new THREE.Vector3();
      b.getSize(s);
      parts.push({ b, volume: s.x * s.y * s.z, tris: child.geometry.index
        ? child.geometry.index.count / 3 : child.geometry.attributes.position.count / 3 });
    });
    // The aircraft is where the triangles are; the banner is a few big quads.
    parts.sort((a, b) => b.tris - a.tris);
    const dense = new THREE.Box3();
    for (const part of parts.slice(0, Math.ceil(parts.length * 0.8))) dense.union(part.b);
    const denseSize = new THREE.Vector3();
    dense.getSize(denseSize);
    dense.getCenter(centre);
    radius = denseSize.length() / 2;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);

  const views = {};
  for (const [label, dir, up] of [
    ['from+X', [1, 0, 0], [0, 1, 0]],
    ['from+Z', [0, 0, 1], [0, 1, 0]],
    ['from+Y', [0, 1, 0], [0, 0, -1]],
  ]) {
    const camera = new THREE.PerspectiveCamera(35, W / H, radius / 100, radius * 10);
    camera.position.copy(centre).add(new THREE.Vector3(...dir).multiplyScalar(radius * 2.6));
    camera.up.set(...up);
    camera.lookAt(centre);

    const target = new THREE.WebGLRenderTarget(W, H);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x101418, 1);
    renderer.clear();
    renderer.render(scene, camera);
    const pixels = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(target, 0, 0, W, H, pixels);
    renderer.setRenderTarget(null);
    target.dispose();
    views[label] = Array.from(pixels);
  }
  renderer.dispose();
  return { views, size: [size.x, size.y, size.z].map((n) => Number(n.toFixed(1))) };
};
