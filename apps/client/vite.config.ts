import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  base: "/shorekeeper/",
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      "/jarvis-livekit": {
        target: "http://127.0.0.1:8082",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jarvis-livekit/, ""),
      },
    },
  },
});