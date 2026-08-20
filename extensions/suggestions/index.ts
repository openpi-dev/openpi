import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  registerEditorLayer,
  removeEditorLayer,
} from "../shared/editor-layers.ts";
import {
  loadSetupConfig,
  SETUP_CONFIG_CHANGED_CHANNEL,
} from "../shared/setup-config.ts";
import { predictNextAction } from "./src/predictor.ts";
import {
  createRunBoundary,
  getRunEntries,
  serializeRunTranscript,
} from "./src/transcript.ts";
import {
  NextActionSuggestionEditor,
  NextActionSuggestionState,
} from "./src/ui.ts";

const STATUS_KEY = "suggestions";
const SHUTDOWN_WAIT_MS = 1_000;

async function waitForCancellation(
  task: Promise<void> | undefined,
  timeoutMs: number,
) {
  if (!task) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface ActivePrediction {
  readonly controller: AbortController;
  readonly task: Promise<void>;
}

export default function (pi: ExtensionAPI) {
  const runBoundary = createRunBoundary();
  const suggestionState = new NextActionSuggestionState();
  let activePrediction: ActivePrediction | undefined;
  let sessionActive = false;
  let statusContext: ExtensionContext | undefined;
  let requestEditorRender: (() => void) | undefined;
  let editorLayerRegistered = false;

  const updateStatus = () => {
    statusContext?.ui.setStatus(
      STATUS_KEY,
      activePrediction
        ? statusContext.ui.theme.fg("muted", "✦ predicting next input…")
        : undefined,
    );
  };

  const cancelPrediction = () => {
    const current = activePrediction;
    activePrediction = undefined;
    suggestionState.cancel();
    current?.controller.abort();
    updateStatus();
    requestEditorRender?.();
  };

  const installSuggestionEditor = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    registerEditorLayer(pi, ctx, {
      id: "suggestions",
      order: 200,
      wrap: (base, tui, _theme, keybindings) => {
        requestEditorRender = () => tui.requestRender();
        return new NextActionSuggestionEditor(
          base,
          keybindings,
          suggestionState,
          cancelPrediction,
          requestEditorRender,
          (text) => ctx.ui.theme.fg("dim", text),
        );
      },
    });
    editorLayerRegistered = true;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionActive = ctx.mode === "tui";
    statusContext = ctx;
    runBoundary.reset();
    cancelPrediction();
    installSuggestionEditor(ctx);
  });

  pi.on("input", () => {
    cancelPrediction();
    return { action: "continue" };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    cancelPrediction();
    runBoundary.begin(ctx.sessionManager.getLeafId());
  });

  pi.on("agent_settled", (_event, ctx) => {
    const run = runBoundary.settle();
    if (!run || ctx.mode !== "tui" || !sessionActive) return;

    const entries = getRunEntries(
      ctx.sessionManager.getBranch(),
      run.baselineLeafId,
    );
    if (entries.length === 0) return;

    const setup = loadSetupConfig();
    if (!setup.suggestions.enabled || !setup.suggestions.model) return;

    cancelPrediction();
    const token = suggestionState.begin();
    const controller = new AbortController();
    statusContext = ctx;
    const task = (async () => {
      try {
        const suggestion = await predictNextAction({
          modelRegistry: ctx.modelRegistry,
          config: setup.suggestions.model!,
          transcript: serializeRunTranscript(entries),
          signal: controller.signal,
        });
        if (!sessionActive || controller.signal.aborted) return;
        suggestionState.offer(
          token,
          suggestion,
          ctx.ui.getEditorText().length === 0,
        );
        requestEditorRender?.();
      } catch {
        if (!controller.signal.aborted) {
          suggestionState.offer(token, undefined, true);
        }
      }
    })().finally(() => {
      if (activePrediction?.controller === controller) {
        activePrediction = undefined;
        updateStatus();
      }
    });

    activePrediction = { controller, task };
    updateStatus();
    void task;
  });

  pi.events.on(SETUP_CONFIG_CHANGED_CHANNEL, cancelPrediction);

  pi.on("session_shutdown", async () => {
    if (editorLayerRegistered) {
      removeEditorLayer(pi, "suggestions");
      editorLayerRegistered = false;
    }
    sessionActive = false;
    runBoundary.reset();
    const task = activePrediction?.task;
    cancelPrediction();
    await waitForCancellation(task, SHUTDOWN_WAIT_MS);
    statusContext?.ui.setStatus(STATUS_KEY, undefined);
    statusContext = undefined;
    requestEditorRender = undefined;
  });
}
