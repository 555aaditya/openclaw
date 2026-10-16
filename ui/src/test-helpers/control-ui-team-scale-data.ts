import type { BoardSnapshot } from "../lib/board/types.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import { workboardUi } from "./control-ui-workboard-fixture.ts";

export const TEAM_SCALE_COUNTS = {
  sessions: 300,
  firstPage: 200,
  pinned: 30,
  owners: 34,
  people: 120,
  agents: 6,
  plugins: 6,
  transcriptMessages: 240,
  inlineWidgets: 12,
  catalogHosts: 6,
  catalogSessionsPerHost: 20,
  presenceEvents: 12,
} as const;

export function widgetHtml(index: number) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Team metric ${index + 1}</title>
<style>:root{color-scheme:dark light;font-family:system-ui}body{margin:0;padding:20px}h2{font-size:18px}progress{width:100%}</style></head>
<body><h2>Team metric ${index + 1}</h2><p>Synthetic completed work: ${60 + index}%</p>
<progress value="${60 + index}" max="100"></progress><p>All fixture systems are available.</p></body></html>`;
}

export const TEAM_SCALE_PANE_FACT_METHODS = [
  "sessions.github.options",
  "session.discussion.info",
  "workboard.boards.list",
  "plugin.surface.refresh",
] as const;

/** Native feature inputs absent from the original synthetic dashboard inventory. */
export function createTeamScalePaneFacts({ now, baseUrl }: { now: number; baseUrl: string }) {
  const canvasPath = "/__openclaw__/canvas/team-scale-canvas/index.html";
  const assets = [
    "",
    "/__openclaw__/cap/team-scale-initial",
    "/__openclaw__/cap/team-scale-refreshed",
  ].map(
    (prefix) =>
      [
        `${prefix}${canvasPath}`,
        {
          contentType: "text/html",
          body: "<!doctype html><title>Surface metric</title><p>Synthetic canvas surface ready</p>",
        },
      ] as const,
  );
  const board = {
    id: "team-workboard",
    name: "Team workboard",
    total: 1,
    active: 1,
    archived: 0,
    byStatus: { ready: 1 },
  };
  const widget: BoardSnapshot["widgets"][number] = {
    name: board.id,
    tabId: "main",
    title: board.name,
    contentKind: "plugin",
    pluginKind: "workboard:board",
    props: { boardId: board.id },
    sizeW: 12,
    sizeH: 5,
    position: 1,
    grantState: "none",
    revision: 1,
  };
  const scenario = {
    ...workboardUi,
    controlUiWidgetKinds: [
      { kind: "workboard:board", label: "Workboard board", pluginId: "workboard" },
    ],
    pluginSurfaceUrls: { canvas: new URL("/__openclaw__/cap/team-scale-initial", baseUrl).href },
    featureMethods: [
      "sessions.github.publish",
      "session.discussion.info",
      "workboard.boards.list",
      "workboard.cards.list",
      "plugin.surface.refresh",
    ],
    methodResponses: {
      "sessions.github.options": {
        shared: { source: "system-configured", accountId: 1, login: "fixture-bot" },
        personal: {
          state: "disconnected",
          generation: null,
          account: null,
          accessExpiresAtMs: null,
          refreshState: "not_applicable",
          pending: null,
        },
        pendingPersonal: null,
        latestShared: null,
      },
      "session.discussion.info": {
        state: "open",
        openUrl: "https://discussion.example.test/fixture",
      },
      "workboard.boards.list": { boards: [board] },
      "workboard.cards.list": {
        boards: [board],
        cards: [
          {
            id: "team-card",
            title: "Review synthetic dashboard",
            status: "ready",
            priority: "normal",
            labels: [],
            position: 1,
            createdAt: now,
            updatedAt: now,
            metadata: { automation: { boardId: board.id } },
          },
        ],
        statuses: ["ready", "done"],
      },
      "plugin.surface.refresh": {
        surface: "canvas",
        pluginSurfaceUrls: {
          canvas: new URL("/__openclaw__/cap/team-scale-refreshed", baseUrl).href,
        },
        expiresAtMs: now + 1_200_000,
      },
    },
  } satisfies ControlUiMockGatewayScenario;
  return {
    assets,
    widget,
    scenario,
    repository: { url: "https://github.com/synthetic/team-scale", branch: "fixture/dashboard" },
    preview: {
      type: "canvas",
      preview: {
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        viewId: "team-scale-canvas",
        title: "Surface metric",
        url: canvasPath,
        preferredHeight: 220,
      },
    },
  };
}
