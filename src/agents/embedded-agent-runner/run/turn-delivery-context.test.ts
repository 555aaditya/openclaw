import { describe, expect, it } from "vitest";
import { buildTurnDeliveryContextFragments } from "./turn-delivery-context.js";

describe("buildTurnDeliveryContextFragments", () => {
  it("states that a send keeps the turn open when the run's final default is false", () => {
    expect(buildTurnDeliveryContextFragments({ messageToolFinalByDefault: false })).toEqual([
      {
        kind: "runtime-instruction",
        text: "A send ends this turn only with `final=true`. With `final` omitted, the turn continues after the send, so finish every remaining step.",
      },
    ]);
  });

  it.each([undefined, true])("adds nothing for the default (%s)", (messageToolFinalByDefault) => {
    expect(buildTurnDeliveryContextFragments({ messageToolFinalByDefault })).toEqual([]);
  });
});
