import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Relative asset URLs: the same build works at / (dev, preview) and at /openosc-panel/ on GitHub Pages.
export default defineConfig({ base: './', plugins: [react(), tailwindcss()] });
