/**
 * The SPA (v1-spec.md §7.1). In development `/api` is proxied to the
 * server on its default port; serving the built bundle from the server
 * process is the deploy's job (backlog #36).
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://localhost:${process.env.CAT_PORT ?? 3400}`,
    },
  },
});
