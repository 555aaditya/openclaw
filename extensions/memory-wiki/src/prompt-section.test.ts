import fsSync from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createWikiPromptSectionBuilder } from "./prompt-section.js";

describe("Memory Wiki prompt section", () => {
  const buildGuidance = createWikiPromptSectionBuilder();

  it("prefers shared memory corpus guidance when memory tools are available", () => {
    const lines = buildGuidance({
      availableTools: new Set(["memory_search", "memory_get", "wiki_search", "wiki_get"]),
    });

    expect(lines.join("\n")).toContain("`memory_search` with `corpus=all`");
    expect(lines.join("\n")).toContain("`memory_get` with `corpus=wiki` or `corpus=all`");
    expect(lines.join("\n")).toContain("wiki-specific ranking or provenance details");
  });

  it("does no filesystem work during synchronous prompt guidance", () => {
    const readFileSync = vi.spyOn(fsSync, "readFileSync");
    try {
      expect(buildGuidance({ availableTools: new Set(["web_search"]) })).toEqual([]);
      expect(
        buildGuidance({ availableTools: new Set(["wiki_search", "wiki_get"]) }).join("\n"),
      ).toContain("## Compiled Wiki");
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      readFileSync.mockRestore();
    }
  });
});
