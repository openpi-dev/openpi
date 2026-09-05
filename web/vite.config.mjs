import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backendOrigin =
  process.env.OPENPI_WEB_BACKEND?.replace(/\/$/u, "") ||
  "http://127.0.0.1:57107";

function backendProxy() {
  return {
    target: backendOrigin,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (request) => {
        // WebHost validates Origin as well as Host. The browser Origin is the
        // Vite dev origin, so normalize it to the loopback backend target.
        request.setHeader("origin", backendOrigin);
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL("./ui/", import.meta.url)),
  publicDir: fileURLToPath(new URL("./ui/public/", import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./dist/", import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "app-[name].js",
        assetFileNames: ({ names }) =>
          names?.some((name) => name.endsWith(".css"))
            ? "styles.css"
            : "[name][extname]",
        manualChunks: undefined,
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.OPENPI_WEB_UI_PORT || 5173),
    strictPort: true,
    proxy: {
      "/api": backendProxy(),
      "/events": backendProxy(),
    },
  },
});
