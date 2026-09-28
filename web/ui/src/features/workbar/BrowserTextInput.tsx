import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { WebEmbeddedBrowserState } from "../../../../protocol/types.ts";

export function BrowserTextInput({
  inputRef,
  target,
  active,
  label,
  width,
  height,
  onText,
  onEditingKey,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  target: WebEmbeddedBrowserState["inputTarget"];
  active: boolean;
  label: string;
  width: number;
  height: number;
  onText: (text: string, owner: string) => void;
  onEditingKey: (key: "Backspace" | "Delete" | "Enter", owner: string) => void;
}) {
  const composition = useRef<{ owner: string; ending: boolean } | null>(null);
  const finalizer = useRef(0);
  const sentOffset = useRef(0);
  const nativeTextKey = useRef(false);
  const capturedKeys = useRef(new Set<string>());
  const acceptsInput = useRef(false);
  const current = useRef({ active, target, onText, onEditingKey });
  current.current = { active, target, onText, onEditingKey };

  const reset = useCallback(() => {
    window.clearTimeout(finalizer.current);
    finalizer.current = 0;
    composition.current = null;
    sentOffset.current = 0;
    nativeTextKey.current = false;
    capturedKeys.current.clear();
    acceptsInput.current = false;
    if (inputRef.current) inputRef.current.value = "";
  }, [inputRef]);

  const canInput = useCallback(
    () =>
      current.current.active &&
      current.current.target &&
      document.activeElement === inputRef.current,
    [inputRef],
  );

  const commit = useCallback(
    (endedOnBlur = false) => {
      const input = inputRef.current;
      const { target: focused, onText: send } = current.current;
      if (
        !input ||
        !focused ||
        !current.current.active ||
        !acceptsInput.current ||
        (!endedOnBlur && !canInput())
      )
        return;
      const text = input.value.slice(sentOffset.current);
      sentOffset.current = input.value.length;
      nativeTextKey.current = false;
      if (text) send(text, focused.owner);
    },
    [canInput, inputRef],
  );

  const finishEnded = useCallback(
    (endedOnBlur = false) => {
      const pending = composition.current;
      if (!pending?.ending || pending.owner !== current.current.target?.owner)
        return;
      window.clearTimeout(finalizer.current);
      composition.current = null;
      commit(endedOnBlur);
    },
    [commit],
  );

  useEffect(() => {
    if (!active || composition.current?.owner !== target?.owner) reset();
    return reset;
  }, [active, target?.owner, reset]);

  useEffect(() => {
    const input = inputRef.current;
    const owner = target?.owner;
    if (!input) return;
    const beforeInput = (event: InputEvent) => {
      const focused = current.current.target;
      if (
        !canInput() ||
        !focused ||
        focused.owner !== owner ||
        event.isComposing
      )
        return;
      const key =
        event.inputType === "deleteContentBackward"
          ? "Backspace"
          : event.inputType === "deleteContentForward"
            ? "Delete"
            : event.inputType === "insertLineBreak" ||
                event.inputType === "insertParagraph"
              ? "Enter"
              : undefined;
      if (key) finishEnded();
      if (composition.current) return;
      if (key) {
        event.preventDefault();
        current.current.onEditingKey(key, focused.owner);
        return;
      }
      if (!event.inputType.startsWith("insert")) return;
      acceptsInput.current = true;
      // Retain a committed prefix through its input echo, then remove it at
      // the next native insertion boundary, not by comparing equal strings.
      if (sentOffset.current === input.value.length) {
        input.value = "";
        sentOffset.current = 0;
      }
    };
    input.addEventListener("beforeinput", beforeInput);
    return () => input.removeEventListener("beforeinput", beforeInput);
  }, [canInput, finishEnded, inputRef, target?.owner]);

  return (
    <textarea
      key={target?.owner ?? "unfocused"}
      ref={inputRef}
      className="browser-text-input"
      aria-label={label}
      tabIndex={-1}
      disabled={!active || !target}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      style={{
        left: `${Math.max(0, Math.min(99, ((target?.anchorRect.x ?? 0) / width) * 100))}%`,
        top: `${Math.max(0, Math.min(99, (((target?.anchorRect.y ?? 0) + Math.min(target?.anchorRect.height ?? 0, 20)) / height) * 100))}%`,
      }}
      onFocus={() => {
        reset();
        acceptsInput.current = Boolean(canInput());
      }}
      onBlur={() => {
        finishEnded(true);
        reset();
      }}
      onPasteCapture={() => {
        finishEnded();
        reset();
      }}
      onKeyDownCapture={(event) => {
        if (!canInput()) return;
        const native = event.nativeEvent;
        const textKey =
          native.isComposing ||
          native.keyCode === 229 ||
          event.key === "Process" ||
          event.key === "Dead" ||
          event.key === "Unidentified" ||
          event.getModifierState("AltGraph") ||
          (event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            event.key.length === 1);
        if (composition.current?.ending && !textKey) {
          finishEnded();
        }
        if (textKey || composition.current || nativeTextKey.current) {
          nativeTextKey.current = true;
          acceptsInput.current = true;
          capturedKeys.current.add(event.code || event.key);
          event.stopPropagation();
        } else capturedKeys.current.delete(event.code || event.key);
      }}
      onKeyUpCapture={(event) => {
        if (capturedKeys.current.delete(event.code || event.key))
          event.stopPropagation();
      }}
      onCompositionStart={() => {
        if (!canInput() || !current.current.target) return;
        finishEnded();
        window.clearTimeout(finalizer.current);
        acceptsInput.current = true;
        composition.current = {
          owner: current.current.target.owner,
          ending: false,
        };
      }}
      onCompositionEnd={() => {
        const pending = composition.current;
        if (!pending || pending.ending) return;
        pending.ending = true;
        // Some engines emit the final input after compositionend. Read the
        // textarea once that native event chain has supplied its final value.
        finalizer.current = window.setTimeout(() => {
          finalizer.current = 0;
          if (composition.current !== pending) return;
          composition.current = null;
          if (current.current.target?.owner === pending.owner) commit();
        }, 0);
      }}
      onInput={(event) => {
        if (
          composition.current ||
          (event.nativeEvent as InputEvent).isComposing
        )
          return;
        commit();
      }}
    />
  );
}
