// Windows Script Host JScript. Node does not execute this file.
// setup-config asks cscript.exe for one process CreationDate. A missing
// process or a failed query exits non-zero so the lock stays fail-closed.
var raw =
  WScript.Arguments.length === 1 ? String(WScript.Arguments.Item(0)) : "";
if (!/^[1-9][0-9]*$/.test(raw)) {
  WScript.Quit(1);
}
var startedAt = "";
try {
  var locator = new ActiveXObject("WbemScripting.SWbemLocator");
  var service = locator.ConnectServer(".", "root\\cimv2");
  // Default Identify makes a local query fail closed. Impersonate is the
  // level Win32_Process expects. 48 is forward-only and return-immediately.
  service.Security_.ImpersonationLevel = 3;
  var processes = service.ExecQuery(
    "SELECT CreationDate FROM Win32_Process WHERE ProcessId=" + raw,
    "WQL",
    48,
  );
  var enumerator = new Enumerator(processes);
  if (!enumerator.atEnd()) startedAt = String(enumerator.item().CreationDate);
} catch (error) {
  startedAt = "";
}
// Quit outside try. JScript turns WScript.Quit into a catchable exception,
// so a failure exit inside try/catch can fall off the end with status 0.
if (!startedAt) WScript.Quit(1);
WScript.Echo(startedAt);
