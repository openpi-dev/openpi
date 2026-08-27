// OSC may end in BEL or ST. DCS/SOS/PM/APC end only in ST; treating BEL as
// their terminator would expose the rest of a still-hidden payload. Both
// patterns consume an unterminated string through the bounded input's end.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c|$)/g;
// eslint-disable-next-line no-control-regex
const ST_STRING_PATTERN =
  /(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])(?:[^\u001b\u009c]|\u001b(?!\\))*(?:\u001b\\|\u009c|$)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// Remaining two-byte/charset escape forms (for example ESC ( 0).
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;
// Invisible Unicode format controls can reorder or disguise untrusted text.
// Keep only ZWNJ/ZWJ (U+200C/U+200D), which carry legitimate shaping and emoji
// semantics; variation selectors are marks rather than Cf and remain intact.
const UNSAFE_FORMAT_PATTERN = /(?![\u200c\u200d])\p{Cf}/gu;
const UNSAFE_FORMAT_CHARACTER = /\p{Cf}/u;
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f]|(?:(?![\u200c\u200d])\p{Cf})/u;

type SanitizerState =
  | "text"
  | "escape"
  | "escape_intermediate"
  | "csi"
  | "osc"
  | "st_string";

/** Stateful terminal-text projection for streams whose retained head can move. */
export class TerminalTextSanitizer {
  private state: SanitizerState = "text";
  private stringEscape = false;

  push(text: string) {
    let safe = "";
    for (const character of text) {
      const code = character.codePointAt(0)!;

      if (this.state === "osc" || this.state === "st_string") {
        if (character === "\u009c") {
          this.state = "text";
          this.stringEscape = false;
        } else if (this.state === "osc" && character === "\u0007") {
          this.state = "text";
          this.stringEscape = false;
        } else if (this.stringEscape && character === "\\") {
          this.state = "text";
          this.stringEscape = false;
        } else {
          this.stringEscape = character === "\u001b";
        }
        continue;
      }

      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        else if (code < 0x20 || code > 0x3f) {
          this.state = "text";
          safe += this.safeCharacter(character, code);
        }
        continue;
      }

      if (this.state === "escape" || this.state === "escape_intermediate") {
        if (this.state === "escape") {
          if (character === "[") {
            this.state = "csi";
            continue;
          }
          if (character === "]") {
            this.state = "osc";
            continue;
          }
          if (
            character === "P" ||
            character === "X" ||
            character === "^" ||
            character === "_"
          ) {
            this.state = "st_string";
            continue;
          }
        }
        if (code >= 0x20 && code <= 0x2f) {
          this.state = "escape_intermediate";
        } else if (code >= 0x30 && code <= 0x7e) {
          this.state = "text";
        } else {
          this.state = "text";
          safe += this.safeCharacter(character, code);
        }
        continue;
      }

      if (character === "\u001b") {
        this.state = "escape";
      } else if (character === "\u009b") {
        this.state = "csi";
      } else if (character === "\u009d") {
        this.state = "osc";
      } else if (
        character === "\u0090" ||
        character === "\u0098" ||
        character === "\u009e" ||
        character === "\u009f"
      ) {
        this.state = "st_string";
      } else {
        safe += this.safeCharacter(character, code);
      }
    }
    return safe;
  }

  private safeCharacter(character: string, code: number) {
    if (character === "\t") return "  ";
    if (
      character === "\n" ||
      character === "\u200c" ||
      character === "\u200d"
    ) {
      return character;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return "";
    return UNSAFE_FORMAT_CHARACTER.test(character) ? "" : character;
  }
}

/** Strip terminal control sequences and direction-spoofing format controls. */
export function sanitizeTerminalText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(ST_STRING_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(UNSAFE_FORMAT_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Reject raw terminal or direction-spoofing controls in display patterns. */
export function hasTerminalControls(text: string) {
  return TERMINAL_CONTROL_PATTERN.test(text);
}
