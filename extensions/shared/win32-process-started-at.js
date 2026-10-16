// Windows Script Host JScript. Node does not execute this file.
// setup-config asks cscript.exe for one process CreationDate. A missing
// process or a failed query exits non-zero so the lock stays fail-closed.
// JScript rejects trailing commas, so keep every call list tight.
var raw =
  WScript.Arguments.length === 1 ? String(WScript.Arguments.Item(0)) : "";
if (!/^[1-9][0-9]*$/.test(raw)) {
  WScript.StdOut.Write("wmi-args");
  WScript.Quit(1);
}
var startedAt = "";
var failure = "wmi-error";
try {
  var locator = new ActiveXObject("WbemScripting.SWbemLocator");
  var service = locator.ConnectServer(".", "root\\cimv2");
  var processes = service.ExecQuery(
    "SELECT CreationDate FROM Win32_Process WHERE ProcessId=" + raw
  );
  var enumerator = new Enumerator(processes);
  if (enumerator.atEnd()) {
    failure = "wmi-empty";
  } else {
    var value = enumerator.item().CreationDate;
    if (value) {
      startedAt = String(value);
      failure = "";
    }
  }
} catch (error) {
  failure = "wmi-error";
  startedAt = "";
}
// Quit outside try. JScript turns WScript.Quit into a catchable exception,
// so a failure exit inside try/catch can fall off the end with status 0.
if (!startedAt) {
  WScript.StdOut.Write(failure);
  WScript.Quit(1);
}
WScript.Echo(startedAt);
