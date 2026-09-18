import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { WebSnapshot } from "../../web/protocol/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = "/m12-fixture/session.jsonl";
const sessionId = "m12-synthetic-session";
const stamp = "2026-09-18T00:00:00Z";

type Entry = NonNullable<WebSnapshot["selectedSession"]>["entries"][number];
type Scenario = "empty" | "long" | "hundred" | "five-hundred" | "truncated";

function entriesFor(scenario: Scenario): Entry[] {
  if (scenario === "empty") return [];
  const count =
    scenario === "five-hundred" ? 500 : scenario === "hundred" ? 100 : 12;
  const wideTable = `| ${"Column_".repeat(18)} | Result |\n| --- | --- |\n| ${"宽表格 ".repeat(16)} | 通过 |`;
  return Array.from({ length: count }, (_, index): Entry => {
    const user = index % 2 === 0;
    const content = user
      ? `问题 ${index}: 长中文段落 ${"保持阅读位置。".repeat(scenario === "long" ? 40 : 2)}`
      : scenario === "long" && index === count - 1
        ? `末尾答案\n\n${wideTable}\n\n\`\`\`ts\nconst value = "中文";\n\`\`\``
        : `答案 ${index}: **确定性文本**`;
    return {
      id: `m12-${index}`,
      type: "message",
      timestamp: stamp,
      message: {
        role: user ? "user" : "assistant",
        content,
        ...(scenario === "long" && index === 5
          ? {
              parts: Array.from({ length: 6 }, (_, child) => ({
                type: "toolCall" as const,
                id: `tool-${child}`,
                name: "bash",
                arguments: JSON.stringify({
                  command: `printf fixture-${child}`,
                }),
              })),
            }
          : {}),
      },
    } as Entry;
  });
}

function projectedSnapshot(base: WebSnapshot, scenario: Scenario): WebSnapshot {
  const entries = entriesFor(scenario);
  const omitted = scenario === "truncated" ? 488 : 0;
  return {
    ...base,
    currentSessionId: sessionId,
    workspaces: [
      { path: "/m12-fixture", name: "M12 synthetic", current: true },
    ],
    sessions: [
      {
        id: sessionId,
        path: fixturePath,
        cwd: "/m12-fixture",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        created: stamp,
        modified: stamp,
        firstMessage: "Synthetic prompt",
        messageCount: entries.length + omitted,
        name: "M12 synthetic",
      },
    ],
    selectedSession: {
      id: sessionId,
      path: fixturePath,
      cwd: "/m12-fixture",
      entries,
      bytes: JSON.stringify(entries).length,
      truncation: {
        truncated: omitted > 0,
        entriesOmitted: omitted,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        maxBytes: 2_097_152,
      },
    },
    runtime: { status: "idle", capabilities: {} },
    truncation: { ...base.truncation, truncated: omitted > 0 },
  };
}

function percentile(samples: number[], quantile: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

async function installFixture(page: Page, scenario: Scenario) {
  let hostSnapshotMs: number | undefined;
  let requests = 0;
  let base: WebSnapshot | undefined;
  await page.route("**/api/snapshot**", async (route) => {
    requests++;
    try {
      if (!base) {
        const start = performance.now();
        const response = await route.fetch();
        hostSnapshotMs = performance.now() - start;
        base = (await response.json()) as WebSnapshot;
      }
      await route.fulfill({ json: projectedSnapshot(base, scenario) });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
  return { hostSnapshotMs: () => hostSnapshotMs, requests: () => requests };
}

async function inputSamples(page: Page) {
  const input = page.getByRole("textbox", { name: "描述任务" });
  await input.evaluate((element) => {
    const samples: number[] = [];
    (window as Window & { m12Samples?: number[] }).m12Samples = samples;
    element.addEventListener(
      "input",
      () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            samples.push(performance.now() - start);
          }),
        );
      },
      { capture: true },
    );
  });
  for (let index = 0; index < 12; index++) {
    await input.fill(`草稿 ${index}\n${"中文输入 ".repeat(index + 1)}`);
  }
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { m12Samples?: number[] }).m12Samples?.length,
      ),
    )
    .toBeGreaterThanOrEqual(12);
  return page.evaluate(
    () => (window as Window & { m12Samples?: number[] }).m12Samples!,
  );
}

for (const width of [1280, 390]) {
  for (const scenario of [
    "empty",
    "long",
    "hundred",
    "five-hundred",
    "truncated",
  ] as const) {
    test(`${scenario} synthetic transcript at ${width}px`, async ({
      page,
      browser,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await installFixture(page, scenario);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const conversation = page.locator(".conversation");
      const count = entriesFor(scenario).length;
      if (count) {
        await expect(
          conversation.locator(".message-row:not(.detail-only)"),
        ).toHaveCount(count);
        await expect(
          conversation.locator(".message-row").last(),
        ).toBeAttached();
      } else {
        await expect(
          page.getByRole("textbox", { name: "描述任务" }),
        ).toBeVisible();
      }
      const initial = await conversation.evaluate((element) => ({
        nodes: element.querySelectorAll("*").length,
        rows: element.querySelectorAll(".message-row").length,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
      const timing = await page.evaluate(() => {
        const resource = performance
          .getEntriesByType("resource")
          .filter(
            (item): item is PerformanceResourceTiming =>
              item instanceof PerformanceResourceTiming &&
              item.name.includes("/api/snapshot"),
          )
          .at(-1);
        return {
          // Includes Playwright assertion/polling, not a React-only render duration.
          responseToObservedMsUpperBound: resource
            ? performance.now() - resource.responseEnd
            : null,
          browserNavigationToObservedMs: performance.now(),
        };
      });
      const samples = await inputSamples(page);
      if (count) {
        await conversation.evaluate((element) =>
          element.scrollTo({ top: 120, behavior: "instant" }),
        );
        await expect
          .poll(() => conversation.evaluate((element) => element.scrollTop))
          .toBe(120);
        await expect(
          page.getByRole("button", { name: "跳至最新" }),
        ).toBeVisible();
        await page
          .getByRole("textbox", { name: "描述任务" })
          .fill("Reading history\n".repeat(12));
        await expect
          .poll(() => conversation.evaluate((element) => element.scrollTop))
          .toBe(120);
        await page.getByRole("button", { name: "跳至最新" }).click();
        await expect
          .poll(() =>
            conversation.evaluate(
              (element) =>
                element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(48);
      }
      if (scenario === "long") {
        await expect(conversation.locator("pre code")).toContainText([
          "const value",
        ]);
        await expect(conversation.locator("table")).toHaveCount(1);
        const table = conversation.locator(".markdown-table-scroll");
        await expect(table).toHaveCount(1);
        expect(
          await table.evaluate(
            (element) => element.scrollWidth > element.clientWidth,
          ),
        ).toBe(true);
        await expect(
          conversation.locator(".tool-group, .tool-evidence-card").first(),
        ).toBeAttached();
        await conversation.evaluate((element) => {
          const target = element.querySelector(".message-body");
          if (!target?.firstChild)
            throw new Error("missing selectable message");
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(target);
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        expect(
          await page.evaluate(() => window.getSelection()?.toString()),
        ).toContain("问题 0");
      }
      if (scenario === "truncated") {
        expect(count).toBe(12);
        expect(await page.locator(".message-row").count()).toBe(12);
      }
      const record = {
        classification: "synthetic UI fixture; not a formal benchmark",
        fixture: {
          scenario,
          entriesDelivered: count,
          entriesOmitted: scenario === "truncated" ? 488 : 0,
        },
        environment: {
          commit: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          browser: browser.browserType().name(),
          browserVersion: browser.version(),
          viewport: { width, height: 844 },
          node: process.version,
          playwright: (
            await import("@playwright/test/package.json", {
              with: { type: "json" },
            })
          ).default.version,
          platform: platform(),
          osRelease: release(),
          cpu: cpus()[0]?.model,
          logicalCores: cpus().length,
          memoryBytes: totalmem(),
          powerMode: "unverified",
        },
        layers: {
          ui: {
            ...initial,
            ...timing,
            inputToTwoFramesMs: {
              samples,
              p50: percentile(samples, 0.5),
              p95: percentile(samples, 0.95),
            },
          },
          transport: {
            nativeHostSnapshotFetchMs: fixture.hostSnapshotMs(),
            snapshotRequests: fixture.requests(),
          },
          provider: "not invoked (route-mocked browser snapshot)",
          runtime: "native Host snapshot fetch only; no Pi turn executed",
        },
      };
      const path = testInfo.outputPath(
        `m12-${scenario}-${width}-measurement.json`,
      );
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
      await testInfo.attach("M12 measurement", {
        path,
        contentType: "application/json",
      });
      if (process.env.OPENPI_WEB_PERF_SCREENSHOTS === "1") {
        const screenshot = testInfo.outputPath(
          `m12-${scenario}-${width}-${browser.browserType().name()}.png`,
        );
        await page.screenshot({ path: screenshot, animations: "disabled" });
        await testInfo.attach("M12 screenshot", {
          path: screenshot,
          contentType: "image/png",
        });
      }
    });
  }
}

test("transport interruption refreshes the same synthetic session without prompt admission", async ({
  page,
}, testInfo) => {
  const fixture = await installFixture(page, "hundred");
  let connections = 0;
  let admissions = 0;
  await page.route("**/api/prompt", async (route) => {
    admissions++;
    await route.abort();
  });
  await page.route("**/events?**", async (route) => {
    connections++;
    if (connections === 1) await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/");
  await expect(
    page
      .getByRole("log", { name: "Conversation" })
      .locator(".message-row:not(.detail-only)"),
  ).toHaveCount(100);
  await expect.poll(() => fixture.requests()).toBeGreaterThanOrEqual(2);
  await expect.poll(() => connections).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".connection-state").first()).toHaveClass(
    /connected/,
  );
  expect(admissions).toBe(0);
  const path = testInfo.outputPath("m12-transport-recovery.json");
  await writeFile(
    path,
    `${JSON.stringify({ classification: "synthetic transport failure", sessionId, connections, snapshotRequests: fixture.requests(), promptAdmissions: admissions, provider: "not invoked", runtime: "no Pi turn executed" }, null, 2)}\n`,
  );
  await testInfo.attach("M12 transport recovery", {
    path,
    contentType: "application/json",
  });
});
