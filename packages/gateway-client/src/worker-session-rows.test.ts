import { expect, test } from "vitest";
import { GatewayWorkerSessionRows } from "./worker-session-rows.js";

test("row publications preserve exact window contents, ordering, explicit clears and unchanged identities", () => {
  const host = new GatewayWorkerSessionRows();
  const page = new GatewayWorkerSessionRows();
  const publish = (query: unknown, sessions: Array<{ key: string; title: string | null }>) => {
    const wire = structuredClone(
      host.encode("sessions.list", query, { sessions, total: sessions.length, offset: 0 }),
    );
    return page.decode(wire) as { sessions: typeof sessions; total: number; offset: number };
  };
  const first = publish({ agentId: "main" }, [
    { key: "a", title: "Alpha" },
    { key: "b", title: "Beta" },
  ]);
  const second = publish({ agentId: "main" }, [
    { key: "b", title: "Beta" },
    { key: "a", title: null },
  ]);
  expect(second).toEqual({
    sessions: [
      { key: "b", title: "Beta" },
      { key: "a", title: null },
    ],
    total: 2,
    offset: 0,
  });
  expect(second.sessions[0]).toBe(first.sessions[1]);
  const otherWindow = publish({ agentId: "other" }, [{ key: "a", title: "Other scope" }]);
  expect(otherWindow.sessions[0]?.title).toBe("Other scope");
  expect(publish({ agentId: "main" }, [{ key: "b", title: "Beta" }]).sessions[0]).toBe(
    first.sessions[1],
  );
  host.clear();
  page.clear();
  expect(
    publish({ agentId: "main" }, [{ key: "b", title: "New connection" }]).sessions[0]?.title,
  ).toBe("New connection");
});
