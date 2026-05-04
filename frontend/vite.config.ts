import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
  optimizeDeps: {
    // pdf.js ships an ESM build; let Vite pre-bundle it for fast HMR
    include: ["pdfjs-dist"],
  },
});
