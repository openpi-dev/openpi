import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const source = new URL("../web/browser-extension/", import.meta.url);
const output = new URL("../web/browser-extension-portable/", import.meta.url);
await build({
  configFile: false,
  publicDir: false,
  resolve: {
    // The portable package does not need Chromium's debugger implementation.
    alias: {
      "./browser-driver.js": fileURLToPath(
        new URL("portable-control.js", source),
      ),
    },
  },
  build: {
    outDir: fileURLToPath(output),
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("portable-background.js", source)),
      formats: ["es"],
      fileName: () => "background.js",
    },
  },
});
await mkdir(output, { recursive: true });
for (const file of [
  "connector.js",
  "portable-page.js",
  "LICENSE.pi-computer-use",
])
  await copyFile(new URL(file, source), new URL(file, output));
await copyFile(
  new URL("manifest.portable.json", source),
  new URL("manifest.json", output),
);
