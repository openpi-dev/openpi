import DOMPurify from "dompurify";

// Optional presentation only. Bound retained source and never guess a language.
const cache = new Map<string, string>();
export async function highlightCode(source: string, language: string) {
  if (!source || source.length > 100_000 || !language) return "";
  const key = `${language}\0${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const { default: highlight } = await import("highlight.js/lib/common");
  if (!highlight.getLanguage(language)) return "";
  const html = DOMPurify.sanitize(
    highlight.highlight(source, { language, ignoreIllegals: true }).value,
    { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class"] },
  );
  cache.set(key, html);
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return html;
}
