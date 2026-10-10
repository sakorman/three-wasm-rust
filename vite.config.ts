import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { rollupOptions: { input: { engine: 'index.html', lab: 'lab.html' } } },
});
