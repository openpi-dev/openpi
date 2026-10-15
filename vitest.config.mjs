import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { defineConfig } from "vitest/config";

// Test-only: Vite's **/.git/** deny also matches the ancestor of an isolated
// .git/pi-worktrees checkout. Keep its default private-file matcher and strict
// allow-list, but evaluate checkout files relative to that checkout boundary.
// The Web dev server deliberately retains Vite's unmodified deny policy.
export default defineConfig({
  plugins: [
    {
      name: "openpi-worktree-test-files",
      configResolved(config) {
        const deny = config.fsDenyGlob;
        if (typeof deny !== "function") {
          throw new Error("Vite's file deny matcher is unavailable");
        }
        const nested = config.root.toLowerCase().split("/").includes(".git");
        const isDenied = (file) => {
          const local = relative(config.root, file).replaceAll("\\", "/");
          const inside =
            local !== ".." && !local.startsWith("../") && !isAbsolute(local);
          // Worktree .git pointer files are metadata too, not only directories.
          if (inside && local.toLowerCase().split("/").includes(".git")) {
            return true;
          }
          return deny(nested && inside ? local : file);
        };
        config.fsDenyGlob = (file) => {
          if (isDenied(file)) return true;
          try {
            // Static HTTP serving can retain the lexical alias. Check its
            // actual target too, without widening Vite's existing allow-list.
            return isDenied(realpathSync.native(file));
          } catch (error) {
            // Missing paths contain no readable target; let Vite return 404.
            // Other lookup failures must not silently bypass target denial.
            return error.code !== "ENOENT" && error.code !== "ENOTDIR";
          }
        };
      },
    },
  ],
});
