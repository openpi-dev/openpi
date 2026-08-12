#!/usr/bin/env node
/**
 * Re-apply the kernel resume-render patch (npm updates to
 * @earendil-works/pi-coding-agent overwrite dist/, so the patch must be
 * re-applied after every upgrade).
 *
 * Problem: `rebindCurrentSession({ renderBeforeBind: true })` renders the
 * resumed session BEFORE extension bindings run, then extension UI installs
 * (widgets, header/footer) force a second full-viewport repaint — the visible
 * "double refresh" on /resume. Moving the initial render AFTER
 * `bindCurrentSessionExtensions()` produces one frame that already carries
 * extension UI.
 *
 * Usage: node scripts/reapply-kernel-resume-patch.mjs [--check]
 *   --check  verify whether the patch is applied (exit 0 = applied).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KERNEL =
  "/home/umax/.local/lib/node_modules/@earendil-works/pi-coding-agent";
const TARGET = join(KERNEL, "dist/modes/interactive/interactive-mode.js");

const OLD = `        if (options.renderBeforeBind) {
            this.renderCurrentSessionState();
            this.subscribeToAgent();
        }
        await this.bindCurrentSessionExtensions();
        if (this.session !== session) {
            return;
        }
        if (!options.renderBeforeBind) {
            this.subscribeToAgent();
        }`;

const NEW = `        // Render AFTER the extensions bind, so the first painted frame already
        // carries extension UI (widgets, header/footer, editor wraps). Rendering
        // before the bind produced two visibly different frames on every
        // /resume: frame A without extension UI, frame B with it. One frame now.
        await this.bindCurrentSessionExtensions();
        if (this.session !== session) {
            return;
        }
        if (options.renderBeforeBind) {
            this.renderCurrentSessionState();
            this.subscribeToAgent();
        } else {
            this.subscribeToAgent();
        }`;

const check = process.argv.includes("--check");

try {
  const source = readFileSync(TARGET, "utf8");
  if (source.includes(NEW)) {
    if (!check) console.log("Patch already applied ✓");
    process.exit(0);
  }
  if (check) {
    console.error(
      "Patch NOT applied — run: node scripts/reapply-kernel-resume-patch.mjs",
    );
    process.exit(1);
  }
  if (!source.includes(OLD)) {
    console.error(
      "Cannot locate the original block — the kernel layout changed; re-derive the patch manually.",
    );
    process.exit(1);
  }
  writeFileSync(TARGET, source.replace(OLD, NEW), "utf8");
  console.log(
    "Kernel resume-render patch applied ✓ (backup: interactive-mode.js.bak-resume-render)",
  );
} catch (error) {
  console.error(
    `Failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
