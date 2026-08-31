// Newlines are deliberately not invocation boundaries. Completion and submitted
// references share this rule, including at the start of an editor's later line.
export function startsAtReferenceBoundary(prompt: string, index: number) {
  if (index === 0) return true;
  const previous = prompt[index - 1];
  return previous === " " || previous === "\t";
}
