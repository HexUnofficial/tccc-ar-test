import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/*
 * setup.html is an authoring tool rather than part of the experience, but it is
 * deployed alongside it: served from the real origin its QR codes encode a
 * public HTTPS URL, which is far easier to open on a phone than a LAN address
 * behind a self-signed certificate.
 *
 * It is not linked from anywhere, and it only *emits* links — it cannot change
 * the deployed experience by itself. What decides whether those links do
 * anything is LOCKED in src/location.js.
 *
 * Set EXCLUDE_SETUP=1 to leave it out of a build.
 */
const includeSetup = process.env.EXCLUDE_SETUP !== '1';

// getUserMedia, geolocation and DeviceOrientationEvent all require a secure
// context, so even local development has to be served over HTTPS.
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  resolve: {
    /*
     * locar depends on three ^0.181.0, which for a 0.x version excludes our
     * 0.185.1 — so npm installs a second copy nested under locar and the bundle
     * ships three twice (~480 KB wasted). Worse, two THREE module instances
     * mean two sets of classes, so anything relying on instanceof across the
     * boundary is quietly broken. Resolve every `three` import to one copy.
     */
    dedupe: ['three'],
  },
  server: {
    host: true, // listen on the LAN so a phone can reach it
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        ...(includeSetup ? { setup: resolve(import.meta.dirname, 'setup.html') } : {}),
      },
      output: {
        /*
         * Keep each dependency in its own chunk. Without this, Rollup parks
         * shared CommonJS interop helpers inside whichever *entry* chunk needs
         * them first — so setup.html ended up importing the AR entry and
         * running its bootstrap against a DOM that has no AR in it. Splitting
         * by package also stops the AR page from downloading Leaflet.
         */
        manualChunks(id) {
          const marker = 'node_modules';
          const at = id.lastIndexOf(marker);
          if (at === -1) return undefined;
          // Normalise Windows separators before splitting.
          const parts = id.slice(at + marker.length + 1).split(String.fromCharCode(92)).join('/').split('/');
          // Scoped packages keep both segments: @scope/name.
          const pkg = parts[0].startsWith('@') ? `${parts[0]}-${parts[1]}` : parts[0];
          return `vendor-${pkg.replace('@', '')}`;
        },
      },
    },
  },
});
