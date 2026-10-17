import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-host-core";

function buildWikiToolGuidance(availableTools: Set<string>): string[] {
  const hasWikiSearch = availableTools.has("wiki_search");
  const hasWikiGet = availableTools.has("wiki_get");
  const guidance = [
    availableTools.has("memory_search")
      ? "Prefer `memory_search` with `corpus=all` for one recall pass across durable memory and the compiled wiki when both are relevant."
      : "",
    availableTools.has("memory_get")
      ? "Use `memory_get` with `corpus=wiki` or `corpus=all` when you already know the page path and want a small excerpt without leaving the shared memory tool flow."
      : "",
    hasWikiSearch && hasWikiGet
      ? "Workflow: `wiki_search` first, then `wiki_get` for the exact page or imported memory file you need. Use this when you want wiki-specific ranking or provenance details instead of the broader shared memory flow."
      : hasWikiSearch
        ? "Use `wiki_search` before answering from stored knowledge when you want wiki-specific ranking or provenance details."
        : hasWikiGet
          ? "Use `wiki_get` to inspect specific wiki pages or imported memory files by path/id."
          : "",
    availableTools.has("wiki_apply")
      ? "Use `wiki_apply` for narrow synthesis filing and metadata repair instead of rewriting managed markdown blocks by hand."
      : "",
    availableTools.has("wiki_lint")
      ? "After meaningful wiki updates, run `wiki_lint` before trusting the vault."
      : "",
  ].filter(Boolean);
  return guidance.length > 0
    ? [
        "## Compiled Wiki",
        "Use the wiki when the answer depends on accumulated project knowledge, prior syntheses, entity pages, or source-backed notes that should survive beyond one conversation.",
        ...guidance,
        "",
      ]
    : [];
}

export function createWikiPromptSectionBuilder(): MemoryPromptSectionBuilder {
  return ({ availableTools }) => buildWikiToolGuidance(availableTools);
}
