import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const selectedDirectoryVariable = "OPENPI_TEST_SELECTED_DIRECTORY";

const fakeFolderDialog = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936)
function New-Object {
  param(
    [Parameter(Position = 0)] [string] $TypeName,
    [Parameter(Position = 1)] [object[]] $ArgumentList,
    [string] $ComObject
  )
  if ($ComObject -ne 'Shell.Application') {
    return Microsoft.PowerShell.Utility\\New-Object @PSBoundParameters
  }
  $dialog = [pscustomobject]@{}
  $dialog | Add-Member -MemberType ScriptMethod -Name BrowseForFolder -Value {
    param($owner, $title, $options)
    $selected = [Environment]::GetEnvironmentVariable('${selectedDirectoryVariable}')
    if ([string]::IsNullOrEmpty($selected)) { return $null }
    return [pscustomobject]@{ Self = [pscustomobject]@{ Path = $selected } }
  }
  return $dialog
}
`;

test("Windows workspace folder picker preserves Unicode paths across the PowerShell stdout boundary", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), "openpi-directory-chooser-"),
  );
  try {
    const agentDirectory = join(fixtureRoot, "agent");
    await mkdir(agentDirectory);
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
    let chooserScript: string;
    try {
      process.env.PI_CODING_AGENT_DIR = agentDirectory;
      const { WINDOWS_DIRECTORY_CHOOSER_SCRIPT } = await import(
        "../../web/host/web-host.ts"
      );
      chooserScript = WINDOWS_DIRECTORY_CHOOSER_SCRIPT;
    } finally {
      if (previousAgentDirectory === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }

    const encodedCommand = Buffer.from(
      `${fakeFolderDialog}\n${chooserScript}`,
      "utf16le",
    ).toString("base64");
    const choose = (selectedPath: string) =>
      execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-EncodedCommand", encodedCommand],
        {
          encoding: "buffer",
          timeout: 10_000,
          windowsHide: true,
          env: { ...process.env, [selectedDirectoryVariable]: selectedPath },
        },
      );

    for (const directoryName of ["学校", "学校 有空格", "学校 😀 folder"]) {
      await t.test(`preserves ${directoryName}`, async () => {
        const selectedPath = join(fixtureRoot, directoryName);
        await mkdir(selectedPath);
        const { stdout } = await choose(selectedPath);
        assert.deepEqual(stdout, Buffer.from(`${selectedPath}\r\n`, "utf8"));
        const decodedPath = stdout.toString("utf8").trim();
        assert.equal(decodedPath, selectedPath);
        assert.equal(await realpath(decodedPath), await realpath(selectedPath));
      });
    }
    await t.test("cancellation produces no selected path", async () => {
      const { stdout } = await choose("");
      assert.equal(stdout.length, 0);
    });
  } finally {
    const cleanupPath = resolve(fixtureRoot);
    const temporaryBase = resolve(tmpdir());
    const fromTemporaryBase = relative(temporaryBase, cleanupPath);
    assert.ok(isAbsolute(cleanupPath));
    assert.ok(fromTemporaryBase.startsWith("openpi-directory-chooser-"));
    assert.ok(
      !isAbsolute(fromTemporaryBase) && !fromTemporaryBase.startsWith(".."),
    );
    await rm(cleanupPath, { recursive: true, force: true });
  }
});
