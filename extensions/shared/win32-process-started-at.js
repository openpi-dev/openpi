// Windows Script Host JScript. Node does not execute this file.
// setup-config asks cscript.exe for one process CreationDate. A missing
// process or a failed query exits non-zero so the lock stays fail-closed.
var raw =
  WScript.Arguments.length === 1 ? String(WScript.Arguments.Item(0)) : "";
if (!/^[1-9][0-9]*$/.test(raw)) {
  WScript.Quit(1);
}
try {
  var locator = new ActiveXObject("WbemScripting.SWbemLocator");
  var service = locator.ConnectServer(".", "root\\cimv2");
  var processes = service.ExecQuery(
    "SELECT CreationDate FROM Win32_Process WHERE ProcessId=" + raw,
  );
  var enumerator = new Enumerator(processes);
  if (enumerator.atEnd()) WScript.Quit(1);
  var startedAt = enumerator.item().CreationDate;
  if (!startedAt) WScript.Quit(1);
  WScript.StdOut.Write(String(startedAt));
} catch (error) {
  WScript.Quit(1);
}
