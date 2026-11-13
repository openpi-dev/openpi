const textExtensions = new Set(
  "txt md markdown csv tsv json jsonl ndjson xml html htm css scss sass less yaml yml toml ini cfg conf config log rst tex diff patch sql graphql gql py ipynb js mjs cjs jsx ts mts cts tsx java kt kts scala c cc cpp cxx h hpp cs go rs rb php swift sh bash zsh fish ps1 bat cmd r lua pl proto vue svelte astro svg srt vtt env gitignore dockerignore editorconfig properties lock".split(
    " ",
  ),
);

export function promptFileKind(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
) {
  const extension = name.split(".").at(-1)?.toLowerCase() || "";
  if (new TextDecoder("ascii").decode(bytes.subarray(0, 5)) === "%PDF-")
    return "pdf";
  if (["pdf", "docx", "xlsx", "pptx"].includes(extension)) return extension;
  if (
    textExtensions.has(extension) ||
    /^(?:readme|license|licence|changelog|dockerfile|makefile|gemfile)$/iu.test(
      name,
    ) ||
    mimeType.startsWith("text/") ||
    /^application\/(?:json|(?:[^;]+\+)?xml|javascript|x-yaml)(?:;|$)/iu.test(
      mimeType,
    )
  )
    return "text";
  return "binary";
}
