import { expect, it } from "vitest";
import { listControlUiPluginWidgetKinds } from "./control-ui-plugin-tabs.js";

it("advertises built-in session widgets only to readers", () => {
  const kinds = ["session:progress", "session:report", "session:website"];
  for (const scope of ["operator.admin", "operator.read", "operator.write"]) {
    expect(
      listControlUiPluginWidgetKinds([scope])
        .map((widget) => widget.kind)
        .toSorted(),
    ).toEqual(kinds);
  }
  expect(listControlUiPluginWidgetKinds([])).toEqual([]);
});
