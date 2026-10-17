import { describe, expect, it } from "vitest";
import { parseManifest, parsePluginContent } from "./sqlite-board-codec.js";

describe("board widget manifest codec", () => {
  it("rejects retired source descriptors instead of treating them as native widget props", () => {
    expect(() =>
      parsePluginContent(JSON.stringify({ pluginKind: "diagram:diagram", source: "source" })),
    ).toThrow(/unsupported/i);
    expect(
      parsePluginContent(JSON.stringify({ pluginKind: "report", props: { title: "Report" } })),
    ).toEqual({ pluginKind: "report", props: { title: "Report" } });
  });

  it.each([
    { contentOwner: "unknown" },
    { contentOwner: "registered" },
    { contentOwner: "registered", registeredContentKind: "diagram" },
    { registeredInstanceId: "a".repeat(32) },
    { contentOwner: "plugin", registeredContentKind: "diagram" },
  ])("rejects invalid explicit widget ownership %j", (manifest) => {
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow(/content ownership/i);
  });

  it("ignores invalid persisted frame preferences", () => {
    expect(
      parseManifest(JSON.stringify({ presentation: "floating", heightMode: "elastic" })),
    ).toEqual({});
  });

  it("flags invalid persisted generated name identity metadata", () => {
    expect(
      parseManifest(
        JSON.stringify({
          nameIdentity: { kind: "generated", source: "show_widget", key: "short" },
        }),
      ),
    ).toEqual({ nameIdentityInvalid: true });
  });
});
