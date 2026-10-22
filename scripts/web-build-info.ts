import { createHash } from "node:crypto";
import type { Plugin } from "vite";

const placeholder = "__OPENPI_WEB_BUILD_ID_PLACEHOLDER__";

/** Fingerprint emitted content before inserting its identity, keeping rebuilds deterministic. */
export function webBuildInfoPlugin(version: string): Plugin {
  return {
    name: "openpi-web-build-info",
    config(_config, { command }) {
      return {
        define: {
          __OPENPI_WEB_BUILD__: JSON.stringify({
            version,
            id: command === "build" ? placeholder : null,
            mode: command === "build" ? "production" : "development",
          }),
        },
      };
    },
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      hash.update(JSON.stringify({ version }));
      for (const name of Object.keys(bundle).sort()) {
        const item = bundle[name]!;
        const content = item.type === "chunk" ? item.code : item.source;
        const bytes = Buffer.from(content);
        hash.update(JSON.stringify([name, bytes.length]));
        hash.update(bytes);
      }
      const id = hash.digest("hex");
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk")
          item.code = item.code.replaceAll(placeholder, id);
      }
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: `${JSON.stringify({ version, id, mode: "production" }, null, 2)}\n`,
      });
    },
  };
}
