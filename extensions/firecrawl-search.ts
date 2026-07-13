import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Firecrawl } from "firecrawl";
import { Type } from "typebox";

function readEnvValue(name: string) {
  if (process.env[name]) return process.env[name];

  const envPath = join(homedir(), ".pi", "agent", ".env");
  let envText = "";

  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || match[1] !== name) continue;

    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value.replace(/\s+#.*$/, "");
  }

  return undefined;
}

function createClient() {
  const apiKey = readEnvValue("FIRECRAWL_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing FIRECRAWL_API_KEY in the environment or ~/.pi/agent/.env",
    );
  }

  return new Firecrawl({ apiKey });
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function throwToolError(operation: string, error: unknown): never {
  throw new Error(`Firecrawl ${operation} failed: ${asErrorMessage(error)}`, {
    cause: error,
  });
}

function checkCancellation(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Firecrawl request cancelled");
}

async function formatOutput(value: unknown, operation: string) {
  const output = typeof value === "string" ? value : stringify(value);
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) return output;

  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-firecrawl-"));
  const outputPath = join(outputDirectory, `${operation}.json`);
  await writeFile(outputPath, output, "utf8");

  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`;
}

export default function firecrawlTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search Web",
    description:
      "Search the web with Firecrawl. Returns web, news, or image results. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.",
    promptSnippet: "Search the web with Firecrawl for current information.",
    promptGuidelines: [
      "Use search when the user asks for current web information, discovery, or sources beyond the local workspace.",
      "Use scrape after search when you need the full readable content of a specific page.",
      "Use crawl when the user needs content from multiple pages of the same website.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The web search query." }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of results. Defaults to 5.",
          minimum: 1,
          maximum: 20,
        }),
      ),
      source: Type.Optional(StringEnum(["web", "news", "images"] as const)),
      scrapeResults: Type.Optional(
        Type.Boolean({
          description:
            "Whether to include markdown scraped from each result. Defaults to false.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        checkCancellation(signal);
        onUpdate?.({
          content: [
            { type: "text", text: `Searching Firecrawl for: ${params.query}` },
          ],
          details: undefined,
        });

        const result = await createClient().search(params.query, {
          limit: params.limit ?? 5,
          sources: [params.source ?? "web"],
          scrapeOptions: params.scrapeResults
            ? { formats: ["markdown"], timeout: 30_000 }
            : undefined,
          timeout: 30_000,
        });
        checkCancellation(signal);

        return {
          content: [
            { type: "text", text: await formatOutput(result, "search") },
          ],
          details: result,
        };
      } catch (error) {
        throwToolError("search", error);
      }
    },
  });

  pi.registerTool({
    name: "crawl",
    label: "Crawl Website",
    description:
      "Crawl multiple pages of a website with Firecrawl and return markdown documents. Defaults to 20 pages and never accepts a limit above 100. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.",
    promptSnippet: "Crawl multiple pages of a website with Firecrawl.",
    promptGuidelines: [
      "Use crawl when the user needs content from multiple related pages on one website.",
      "Keep crawl limits as low as practical because each crawled page consumes Firecrawl credits.",
      "Use scrape instead of crawl when only one known URL is needed.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The starting URL to crawl." }),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum pages to crawl. Defaults to 20; maximum 100.",
          minimum: 1,
          maximum: 100,
        }),
      ),
      maxDiscoveryDepth: Type.Optional(
        Type.Number({
          description: "Maximum link-discovery depth from the starting URL.",
          minimum: 0,
        }),
      ),
      includePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: "URL pathname regex patterns to include.",
        }),
      ),
      excludePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: "URL pathname regex patterns to exclude.",
        }),
      ),
      crawlEntireDomain: Type.Optional(
        Type.Boolean({
          description: "Allow sibling and parent paths on the same domain.",
        }),
      ),
      allowSubdomains: Type.Optional(
        Type.Boolean({ description: "Allow crawling subdomains." }),
      ),
      sitemap: Type.Optional(StringEnum(["include", "skip", "only"] as const)),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description:
            "Extract only each page's main content. Defaults to true.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Maximum crawl wait time in seconds. Defaults to 120.",
          minimum: 1,
          maximum: 600,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        checkCancellation(signal);
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Crawling up to ${params.limit ?? 20} pages from: ${params.url}`,
            },
          ],
          details: undefined,
        });

        const result = await createClient().crawl(params.url, {
          limit: params.limit ?? 20,
          maxDiscoveryDepth: params.maxDiscoveryDepth,
          includePaths: params.includePaths,
          excludePaths: params.excludePaths,
          crawlEntireDomain: params.crawlEntireDomain,
          allowSubdomains: params.allowSubdomains,
          sitemap: params.sitemap,
          scrapeOptions: {
            formats: ["markdown"],
            onlyMainContent: params.onlyMainContent ?? true,
          },
          pollInterval: 2,
          timeout: params.timeout ?? 120,
        });
        checkCancellation(signal);

        return {
          content: [
            { type: "text", text: await formatOutput(result, "crawl") },
          ],
          details: result,
        };
      } catch (error) {
        throwToolError("crawl", error);
      }
    },
  });

  pi.registerTool({
    name: "scrape",
    label: "Scrape Page",
    description:
      "Scrape one page with Firecrawl and return markdown. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.",
    promptSnippet: "Fetch one URL as readable markdown with Firecrawl.",
    promptGuidelines: [
      "Use scrape when you need the full readable markdown content of one known URL.",
      "Prefer scrape over bash or raw HTTP fetching for web pages because scrape returns cleaned content.",
      "Use crawl instead when content is needed from multiple pages on the same website.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to scrape." }),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: "Return only the main page content. Defaults to true.",
        }),
      ),
      waitFor: Type.Optional(
        Type.Number({
          description:
            "Milliseconds to wait before capture, useful for JavaScript-heavy pages.",
          minimum: 0,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Request timeout in milliseconds. Defaults to 30000.",
          minimum: 1,
        }),
      ),
      includeMetadata: Type.Optional(
        Type.Boolean({
          description:
            "Append page metadata to the markdown. Defaults to false; metadata remains available in tool details.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      try {
        checkCancellation(signal);
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Scraping page with Firecrawl: ${params.url}`,
            },
          ],
          details: undefined,
        });

        const document = await createClient().scrape(params.url, {
          formats: ["markdown"],
          onlyMainContent: params.onlyMainContent ?? true,
          waitFor: params.waitFor,
          timeout: params.timeout ?? 30_000,
        });
        checkCancellation(signal);

        const metadata =
          params.includeMetadata && document.metadata
            ? `\n\nMetadata:\n${stringify(document.metadata)}`
            : "";
        const markdown =
          document.markdown?.trim() || "No markdown content returned.";
        const output = `${markdown}${metadata}`;

        return {
          content: [
            { type: "text", text: await formatOutput(output, "scrape") },
          ],
          details: document,
        };
      } catch (error) {
        throwToolError("scrape", error);
      }
    },
  });
}
