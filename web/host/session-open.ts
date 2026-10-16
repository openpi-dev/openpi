import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { WebRuntimeRequestError } from "../runtime/types.ts";

// These are host applications, not caller-provided commands or shell fragments.
const macApplications = [
  { id: "finder", label: "Finder", path: "/System/Library/CoreServices/Finder.app" },
  { id: "vscode", label: "Visual Studio Code", path: "/Applications/Visual Studio Code.app" },
  { id: "cursor", label: "Cursor", path: "/Applications/Cursor.app" },
  { id: "terminal", label: "Terminal", path: "/System/Applications/Utilities/Terminal.app" },
];

export async function sessionOpenTargets() {
  if (process.platform !== "darwin") return [];
  const available = await Promise.all(macApplications.map(async (application) =>
    await access(application.path).then(() => true, () => false) ? application : undefined,
  ));
  return available.flatMap((application) => application ? [{ id: application.id, label: application.label }] : []);
}

export async function openSessionDirectory(cwd: string, target: string) {
  const application = macApplications.find((application) => application.id === target);
  if (!application || !(await sessionOpenTargets()).some((item) => item.id === target))
    throw new WebRuntimeRequestError("Application is no longer available; reopen the menu", "SESSION_OPEN_UNAVAILABLE", 409);
  const directory = await realpath(cwd);
  if (!(await stat(directory)).isDirectory())
    throw new WebRuntimeRequestError("Project directory is unavailable", "WORKSPACE_NOT_FOUND", 404);
  await promisify(execFile)("/usr/bin/open", ["-a", application.path, "--", directory], { timeout: 10_000 });
  return { opened: true as const };
}
