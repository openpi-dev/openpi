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
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** Strip terminal control sequences and make tabs width-stable for the TUI. */
export function sanitizeTerminalText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(ST_STRING_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Patterns shown in the transcript must never contain raw control bytes. */
export function hasTerminalControls(text: string) {
  return TERMINAL_CONTROL_PATTERN.test(text);
}
