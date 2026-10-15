import * as cdp from "./computer-use.js";
import * as portable from "./portable-control.js";

// Keep Chromium's debugger implementation; WebKit and Gecko use private
// extension ports bound to an exact content-script document instead.
export const { controlBrowser, cancelBrowserControl } = chrome.debugger
  ? cdp
  : portable;
export { portableDocuments } from "./portable-control.js";
