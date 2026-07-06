import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, ".."),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5188,
    strictPort: true,
  },
});
