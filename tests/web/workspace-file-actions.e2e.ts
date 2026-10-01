import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";
import {
  WORKBAR_POSITION_STORAGE_KEY,
  type WorkbarWorkspace,
} from "../../web/ui/src/features/workbar/workbar-position-storage.ts";

test("workspace actions create, import and copy paths through the real Host on desktop and mobile", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const cwd = await mkdtemp(join(tmpdir(), "openpi-files-actions-browser-"));
  const importFolder = await mkdtemp(join(tmpdir(), "openpi-folder-import-"));
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({
    role: "user",
    content: "Workspace file actions",
    timestamp: Date.now(),
  });
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory: cwd,
    sessionManager: manager,
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [],
    setModel: async () => {
      throw new Error("unused");
    },
    newSession: async () => ({
      cancelled: true,
      sessionId: manager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    subscribe: () => () => {},
    dispose: async () => {},
    sendPrompt: async () => {
      throw new Error("File actions must not start a model turn");
    },
  };
  const host = new WebHost({ runtime });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: "zh-CN",
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const mutationRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().endsWith("/api/files/mutate"))
      mutationRequests.push(request.postDataJSON().name);
  });
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.preferences.theme = "system";
    await route.fulfill({ response, json: snapshot });
  });
  try {
    await writeFile(join(cwd, "existing.txt"), "preserve this original\n");
    await host.start();
    await page.goto(host.url);
    await page
      .getByRole("button", { name: /打开工具|Open tools/u, exact: true })
      .click();
    await page
      .locator(".workbar-launcher")
      .getByRole("button", { name: /^(文件|Files)/u })
      .click();
    await page.locator('[data-pane-resizer="right"]').press("End");
    const tree = page.locator(".file-tree");
    const actions = page.locator(".file-explorer");
    await expect(tree.locator('[data-file-row="existing.txt"]')).toBeVisible();
    const dropFile = async (selector: string, name: string) => {
      const transfer = await page.evaluateHandle((filename) => {
        const data = new DataTransfer();
        data.items.add(
          new File([new Uint8Array([4, 5, 6])], filename, {
            type: "application/octet-stream",
          }),
        );
        return data;
      }, name);
      try {
        const target = page.locator(selector);
        await target.dispatchEvent("dragover", { dataTransfer: transfer });
        await expect(page.locator(".file-explorer")).toHaveAttribute(
          "data-drag-over",
          "true",
        );
        await target.dispatchEvent("drop", { dataTransfer: transfer });
        await expect(tree.locator(`[data-file-row="${name}"]`)).toBeVisible();
        expect(await readFile(join(cwd, name))).toEqual(Buffer.from([4, 5, 6]));
        expect(mutationRequests.filter((value) => value === name)).toHaveLength(
          1,
        );
        await expect(actions).not.toHaveAttribute("data-drag-over");
      } finally {
        await transfer.dispose();
      }
    };
    await dropFile(".files-preview-empty", "empty-preview-drop.bin");
    await actions
      .getByRole("button", {
        name: /清除已完成的导入|Clear completed imports/u,
      })
      .click();

    await actions
      .getByRole("button", { name: /新建文件夹|New folder/u })
      .click();
    const directory = actions.getByRole("textbox", {
      name: /文件夹名称|Folder name/u,
    });
    await expect(directory).toBeFocused();
    await directory.fill("新目录");
    const createdDirectory = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/files/mutate") &&
        response.request().postDataJSON().kind === "create-directory",
    );
    await actions.getByRole("button", { name: /^(创建|Create)$/u }).click();
    expect((await createdDirectory).status()).toBe(201);
    expect((await stat(join(cwd, "新目录"))).isDirectory()).toBe(true);
    const folder = tree.locator('[data-file-row="新目录"]');
    await expect(folder).toBeFocused();
    await folder.click();

    await actions.getByRole("button", { name: /新建文件$|New file$/u }).click();
    await actions
      .getByRole("textbox", { name: /文件名称|File name/u })
      .fill("notes.md");
    await actions.getByRole("button", { name: /^(创建|Create)$/u }).click();
    const note = tree.locator('[data-file-row="新目录/notes.md"]');
    await expect(note).toBeVisible();
    await expect(note).toBeFocused();
    expect(await readFile(join(cwd, "新目录", "notes.md"), "utf8")).toBe("");
    await expect(page.locator(".artifact-panel-embedded")).toBeVisible();
    await page.getByRole("button", { name: /^(编辑|Edit)$/u }).click();
    const editor = page.getByRole("textbox", {
      name: /文件编辑器|File editor/u,
    });
    await editor.fill("# Created in OpenPI\n\n文件可以立即编辑。\n");
    await editor.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
    await expect
      .poll(() => readFile(join(cwd, "新目录", "notes.md"), "utf8"))
      .toContain("文件可以立即编辑");

    await actions
      .getByRole("button", { name: /^(工作区根目录|Workspace root)$/u })
      .click();
    const uploaded = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/files/mutate") &&
        response.request().postDataJSON().name === "existing.txt",
    );
    await actions
      .locator('input[type="file"]:not([webkitdirectory])')
      .setInputFiles([
        {
          name: "existing.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("must not overwrite"),
        },
        {
          name: "binary.dat",
          mimeType: "application/octet-stream",
          buffer: Buffer.from([0, 255, 42]),
        },
        { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
      ]);
    expect((await uploaded).status()).toBe(409);
    await expect(actions.locator('[data-import-state="done"]')).toHaveCount(2);
    await expect(actions.locator('[data-import-state="error"]')).toHaveCount(1);
    expect(await readFile(join(cwd, "existing.txt"), "utf8")).toBe(
      "preserve this original\n",
    );
    expect(await readFile(join(cwd, "binary.dat"))).toEqual(
      Buffer.from([0, 255, 42]),
    );
    expect((await stat(join(cwd, "empty.txt"))).size).toBe(0);
    await expect(
      actions.getByRole("button", { name: /重试|Retry/u }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("files-import-conflict-desktop.png"),
    });

    await dropFile(".file-explorer", "dropped.bin");
    await dropFile(".artifact-panel-body", "preview-drop.bin");
    await page.locator(".files-tree-toggle").click();
    await expect(page.locator(".files-tree-container")).toBeHidden();
    await dropFile(".artifact-panel-body", "hidden-tree-drop.bin");
    await expect(page.locator(".files-tree-container")).toBeVisible();

    const large = Buffer.alloc(21 * 1024 * 1024, 0x33);
    await actions
      .locator('input[type="file"]:not([webkitdirectory])')
      .setInputFiles({
        name: "large.bin",
        mimeType: "application/octet-stream",
        buffer: large,
      });
    await expect(
      actions.getByText(
        /已保存。预览上限为 20 MiB|Saved. Preview supports up to 20 MiB/u,
      ),
    ).toBeVisible();
    const saved = await readFile(join(cwd, "large.bin"));
    expect(saved.length).toBe(large.length);
    expect(createHash("sha256").update(saved).digest("hex")).toBe(
      createHash("sha256").update(large).digest("hex"),
    );

    // Observe the browser clipboard boundary without changing the developer's OS clipboard.
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            document.body.dataset.copiedPath = value;
          },
        },
      }),
    );
    await tree
      .getByRole("button", {
        name: /existing.txt 的路径操作|Path actions for existing.txt/u,
      })
      .click();
    await page
      .getByRole("menuitem", { name: /复制相对路径|Copy relative path/u })
      .click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-copied-path",
      "existing.txt",
    );
    await tree
      .getByRole("button", {
        name: /existing.txt 的路径操作|Path actions for existing.txt/u,
      })
      .click();
    await page
      .getByRole("menuitem", { name: /复制绝对路径|Copy absolute path/u })
      .click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-copied-path",
      join(cwd, "existing.txt"),
    );

    const rowMenu = async (path: string, label: RegExp) => {
      const item = tree.locator(`[data-file-row="${path}"]`).locator("..");
      await item.hover();
      await item
        .getByRole("button", { name: /的路径操作|Path actions for/u })
        .click();
      await page.getByRole("menuitem", { name: label }).click();
    };
    await rowMenu("existing.txt", /^(重命名|Rename)$/u);
    const renameInput = actions.getByRole("textbox", {
      name: /新名称|New name/u,
    });
    await expect(renameInput).toBeFocused();
    await renameInput.fill("renamed.txt");
    await renameInput.press("Enter");
    await expect(tree.locator('[data-file-row="renamed.txt"]')).toBeVisible();
    expect(await readFile(join(cwd, "renamed.txt"), "utf8")).toBe(
      "preserve this original\n",
    );
    await rowMenu("renamed.txt", /^(移动|Move)$/u);
    const moveInput = actions.getByRole("textbox", {
      name: /目标文件夹|Destination folder/u,
    });
    await moveInput.fill("新目录");
    await moveInput.press("Enter");
    await expect(
      tree.locator('[data-file-row="新目录/renamed.txt"]'),
    ).toBeVisible();
    expect(await readFile(join(cwd, "新目录", "renamed.txt"), "utf8")).toBe(
      "preserve this original\n",
    );

    await actions
      .getByRole("button", { name: /多选文件|Select multiple files/u })
      .click();
    await tree
      .getByRole("checkbox", { name: /^(选择 新目录|Select 新目录)$/u })
      .check();
    await tree
      .getByRole("checkbox", {
        name: /^(选择 renamed.txt|Select renamed.txt)$/u,
      })
      .check();
    await tree
      .getByRole("checkbox", { name: /^(选择 empty.txt|Select empty.txt)$/u })
      .check();
    await actions
      .getByRole("button", { name: /^(移入回收站|Move to trash)$/u })
      .click();
    await expect(
      actions.getByRole("button", { name: /撤销移除|Undo removal/u }),
    ).toBeVisible();
    expect(await stat(join(cwd, ".openpi-trash"))).toBeTruthy();
    await expect(tree.locator('[data-file-row="新目录"]')).toHaveCount(0);
    await expect(
      page.getByText("File no longer exists.", { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("files-trash-batch-desktop.png"),
    });
    await actions
      .getByRole("button", { name: /撤销移除|Undo removal/u })
      .click();
    await expect(tree.locator('[data-file-row="新目录"]')).toBeVisible();
    expect(await readFile(join(cwd, "新目录", "renamed.txt"), "utf8")).toBe(
      "preserve this original\n",
    );
    await rowMenu("empty.txt", /^(移入回收站|Move to trash)$/u);
    await expect(tree.locator('[data-file-row="empty.txt"]')).toHaveCount(0);
    // Reload saves and restores the open tool. Wait for its actual view instead
    // of racing initial rendering with a reopen fallback.
    await page.reload();
    await expect(actions).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          ({ storageKey, sessionId, sessionPath }) => {
            const positions = JSON.parse(
              localStorage.getItem(storageKey) ?? "[]",
            ) as WorkbarWorkspace[];
            const saved = positions.find(
              (position) =>
                position.sessionId === sessionId &&
                position.sessionPath === sessionPath,
            );
            return {
              open: saved?.open,
              active: saved?.reading.tabs?.active,
              launcherOpen: saved?.reading.tabs?.launcherOpen,
            };
          },
          {
            storageKey: WORKBAR_POSITION_STORAGE_KEY,
            sessionId: manager.getSessionId(),
            sessionPath: `current:${manager.getSessionId()}`,
          },
        ),
      )
      .toEqual({ open: true, active: "files", launcherOpen: false });
    await actions
      .getByRole("button", { name: /工作区回收站|Workspace trash/u })
      .click();
    await actions
      .getByRole("button", { name: /^(恢复 empty.txt|Restore empty.txt)$/u })
      .click();
    await expect(tree.locator('[data-file-row="empty.txt"]')).toBeVisible();
    expect((await stat(join(cwd, "empty.txt"))).size).toBe(0);
    await actions
      .getByRole("button", { name: /工作区回收站|Workspace trash/u })
      .click();

    await mkdir(join(importFolder, "nested"));
    await writeFile(
      join(importFolder, "nested", "中文.bin"),
      Buffer.from([0, 255, 67]),
    );
    await actions.locator("input[webkitdirectory]").setInputFiles(importFolder);
    await expect
      .poll(() =>
        readFile(join(cwd, basename(importFolder), "nested", "中文.bin")).catch(
          () => undefined,
        ),
      )
      .toEqual(Buffer.from([0, 255, 67]));
    await page.screenshot({
      path: testInfo.outputPath("files-organization-desktop.png"),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      actions.getByRole("button", { name: /新建文件$|New file$/u }),
    ).toBeVisible();
    await actions.getByRole("button", { name: /新建文件$|New file$/u }).click();
    const mobileName = actions.getByRole("textbox", {
      name: /文件名称|File name/u,
    });
    await mobileName.fill("mobile.txt");
    await actions.getByRole("button", { name: /^(创建|Create)$/u }).click();
    await expect(tree.locator('[data-file-row="mobile.txt"]')).toBeVisible();
    expect((await stat(join(cwd, "mobile.txt"))).size).toBe(0);
    expect(
      await page
        .locator(".files-workspace")
        .evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath("files-actions-mobile.png"),
    });
    const accessibility = await new AxeBuilder({ page })
      .include(".files-workspace")
      .disableRules(["color-contrast"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(importFolder, { recursive: true, force: true });
  }
});
