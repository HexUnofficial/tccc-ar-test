import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// getUserMedia, geolocation and DeviceOrientationEvent all require a secure
// context, so even local development has to be served over HTTPS.
export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: {
    host: true, // listen on the LAN so a phone can reach it
    port: 5173,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
