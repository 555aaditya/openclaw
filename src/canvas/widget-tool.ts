import { createHash } from "node:crypto";
import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import type { BoardWidgetPutResult } from "../../packages/gateway-protocol/src/index.js";
import { WIDGET_HTML_MAX_UTF8_BYTES } from "../../packages/gateway-protocol/src/schema/canvas.js";
import { optionalStringEnum } from "../agents/schema/string-enum.js";
import { type AnyAgentTool, jsonResult, readToolStringParam } from "../agents/tools/common.js";
import {
  callInProcessGatewayTool,
  type InProcessGatewayCaller,
} from "../agents/tools/in-process-gateway.js";
import { normalizeBoardWidgetDeclared } from "../boards/board-capabilities.js";
import {
  BOARD_REPORT_GUIDANCE,
  BOARD_REPORT_WIDGET_KIND,
  parseBoardReport,
} from "../boards/board-report.js";
import {
  assertWidgetHtmlSize,
  WIDGET_CDN_ORIGINS,
  WidgetHtmlInputError,
} from "../plugin-sdk/widget-html.js";
import { describeDashboardCapabilities } from "../plugins/dashboard-capabilities.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createCanvasDocument } from "./documents.js";
import { findWidgetScriptSyntaxError } from "./widget-script-syntax.js";
import { buildWidgetDocument } from "./wrap.js";

const SHOW_WIDGET_REQUIRED_CLIENT_CAPS = ["inline-widgets"];
const WIDGET_MAX_PER_SCOPE = 32;

function currentPluginRegistry() {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

function createShowWidgetToolSchema(
  kinds: readonly string[],
  capabilityGuidance: string,
  pinnedOnly: boolean,
  reportAvailable: boolean,
) {
  const targets = ["assistant_message"] as const;
  const widgetCode = Type.String({
    description:
      "Required for HTML/SVG. For HTML, send a fragment with optional style/script tags, not a full document or file path. Use fluid widths and wrap or stack narrow layouts; reserve horizontal scrolling for exact geometry.",
  });
  return Type.Object({
    title: Type.String({ description: "Short host title; do not repeat it inside the widget" }),
    widget_code: reportAvailable ? Type.Optional(widgetCode) : widgetCode,
    ...(reportAvailable
      ? {
          report: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: `Native dashboard data; requires pin=true. Omit widget_code, kind, capabilities, and presentation.target. ${BOARD_REPORT_GUIDANCE}`,
            }),
          ),
        }
      : {}),
    kind: optionalStringEnum(kinds, {
      description: `Widget source kind: ${kinds.join(", ")}`,
    }),
    name: Type.Optional(
      Type.String({
        pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
        description:
          "Stable dashboard widget name; reuse the same name with pin=true and new report data or widget_code to update",
      }),
    ),
    pin: pinnedOnly
      ? Type.Literal(true, {
          description: "Required: this surface can only author pinned widgets",
        })
      : Type.Optional(
          Type.Boolean({
            description:
              "Pin only for an explicit dashboard request or multiple non-code visualizations",
          }),
        ),
    tab: Type.Optional(
      Type.String({ pattern: "^[a-z0-9-]{1,40}$", description: "Dashboard tab slug" }),
    ),
    size: optionalStringEnum(["sm", "md", "lg", "xl", "full"] as const, {
      description: "Dashboard size: sm, md, lg, xl, or full",
    }),
    presentation: Type.Optional(
      Type.Object({
        ...(pinnedOnly
          ? {}
          : {
              target: optionalStringEnum(targets, {
                description: ["Where to show the widget. assistant_message: inline in chat"].join(
                  "; ",
                ),
              }),
            }),
        frame: optionalStringEnum(["card", "full-bleed", "frameless"] as const, {
          description: "Pinned dashboard frame: card, full-bleed, or frameless",
        }),
      }),
    ),
    after: Type.Optional(
      Type.String({
        pattern: "^[a-z0-9][a-z0-9._-]{0,63}$",
        description: "Place after this dashboard widget name",
      }),
    ),
    capabilities: Type.Optional(
      Type.Object({
        netOrigins: Type.Optional(
          Type.Array(Type.String(), {
            description: "Exact HTTPS origins the pinned widget may fetch after approval",
          }),
        ),
        tools: Type.Optional(
          Type.Array(Type.String(), {
            description: `Pinned widget host tools: prompt or cron.trigger:<jobId>; grant each read/action ID below unless a scoped grant is specified. ${capabilityGuidance}`,
          }),
        ),
      }),
    ),
  });
}

type ShowWidgetToolOptions = {
  sessionId?: string;
  agentId?: string;
  agentSessionKey?: string;
  stateDir?: string;
  callGateway?: InProcessGatewayCaller;
  inlineHostEnabled?: boolean;
  inlineClientAvailable?: boolean;
  /** Admitted callers without a rendering client may author only durable dashboard widgets. */
  pinnedOnly?: boolean;
};

function slugWidgetName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (slug && slug.length <= 64) {
    return slug;
  }
  const suffix = createHash("sha256").update(title).digest("hex").slice(0, 8);
  const prefix = (slug || "widget").slice(0, 55).replace(/-+$/gu, "") || "widget";
  return `${prefix}-${suffix}`;
}

function generatedWidgetIdentity(title: string, preferredName: string) {
  const key = createHash("sha256").update(title.trim().normalize("NFC")).digest("hex");
  const prefix = preferredName.slice(0, 55).replace(/-+$/gu, "") || "widget";
  return {
    source: "show_widget" as const,
    key,
    fallbackName: `${prefix}-${key.slice(0, 8)}`,
  };
}

function resolveRetentionScope(options: ShowWidgetToolOptions): string {
  const scope = options.sessionId
    ? `session:${options.sessionId}`
    : `agent:${options.agentId ?? "default"}`;
  return createHash("sha256").update(scope).digest("hex");
}

function assertPinnedWidgetDocumentSize(html: string): void {
  if (Buffer.byteLength(html, "utf8") > WIDGET_HTML_MAX_UTF8_BYTES) {
    throw new WidgetHtmlInputError(
      `pin exceeds effective dashboard budget (${WIDGET_HTML_MAX_UTF8_BYTES} UTF-8 bytes after wrapping)`,
    );
  }
}

export function createShowWidgetTool(options: ShowWidgetToolOptions = {}): AnyAgentTool {
  const gatewayCall = options.callGateway ?? callInProcessGatewayTool;
  const pinnedOnly = options.pinnedOnly === true;
  const inlineHostEnabled = options.inlineHostEnabled !== false;
  const inlineAvailable =
    !pinnedOnly && inlineHostEnabled && options.inlineClientAvailable !== false;
  const kinds = ["html"];
  const reportAvailable = Boolean(options.agentSessionKey?.trim());
  const reportGuidance = reportAvailable
    ? " Prefer the report argument with pin=true for data reports; these render natively on the dashboard without a document frame. Reports are dashboard-only; omit widget_code, kind, capabilities, and presentation.target."
    : "";
  const usageGuidance = pinnedOnly
    ? "This surface is pinned-only: set pin=true to create or update a durable session dashboard widget."
    : inlineAvailable
      ? "Keep one-off visualizations inline; pin for explicit dashboard requests or multiple non-code visualizations."
      : "Inline previews are unavailable this turn; set pin=true to save to the session dashboard.";
  return {
    label: "Show Widget",
    name: "show_widget",
    description: `Visual helps? Make widget. Do not wait for ask. ${usageGuidance} Update pinned HTML by name. Use for code architecture, execution traces, performance comparisons, interactive explanations, UI mockups, and dashboards. Text clearer? Skip. Load the visualize skill when available for composition and dashboard authoring. The source kind defaults to html. Send markup directly in widget_code. Scripts, stylesheets, and fonts may load from ${WIDGET_CDN_ORIGINS.join(", ")}; pin library versions. Use direct HTTPS URLs for audio/video, or data/blob URLs for embedded/generated clips. Default videos to controls playsinline preload="auto" so a first frame can appear before playback; do not autoplay. Images and video posters must be data URLs; media playback does not grant fetch access. Inline widgets cannot fetch APIs. Pinned data access needs declared and granted capabilities.netOrigins or capabilities.tools; inline previews never inherit those grants. Keep filters and controls local; user-clicked openclaw.prompt.send(text) requests an agent follow-up in the Control UI. Data, action, state, and cron host APIs are dashboard-only. openclaw.host.controlUiBaseUrl is the Control UI origin plus base path after dashboard initialization, otherwise null; read it at click time. Dashboard HTML links support HTTP(S) destinations only; open them with target="_blank" and rel="noopener noreferrer". Put local workspace file links in chat Markdown, not widget HTML; file:// links cannot open the Files panel. \`title\` is host metadata. Start directly with content; do not repeat the title or recreate dashboard chrome. Use host theme variables such as --text, --muted, --card, --border, --accent, --font-body, and --font-mono. Inline script syntax errors return line and column; fix and retry. Check library loading and rendered interactions; hosting success alone is not visual proof.${reportGuidance}`,
    parameters: createShowWidgetToolSchema(
      kinds,
      describeDashboardCapabilities(currentPluginRegistry()),
      pinnedOnly,
      reportAvailable,
    ),
    ...(pinnedOnly ? {} : { requiredClientCaps: SHOW_WIDGET_REQUIRED_CLIENT_CAPS }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const requestedKind = readToolStringParam(params, "kind");
      const kind = requestedKind ?? "html";
      const rawWidgetCode =
        readToolStringParam(params, "widget_code", {
          trim: false,
        }) ?? "";
      const rawReport = asOptionalRecord(params.report);
      const isReport =
        params.report !== undefined &&
        params.report !== null &&
        !(rawWidgetCode.trim() && rawReport && Object.keys(rawReport).length === 0);
      const title = readToolStringParam(params, "title", { required: true });
      if (!isReport) {
        if (!rawWidgetCode.trim()) {
          throw new WidgetHtmlInputError("widget_code required");
        }
        assertWidgetHtmlSize(rawWidgetCode, WIDGET_HTML_MAX_UTF8_BYTES, {
          inputName: "widget_code",
          unit: "bytes",
        });
        if (kind === "html") {
          // Untrimmed so reported line/column match the widget_code the model sent.
          const scriptError = findWidgetScriptSyntaxError(rawWidgetCode);
          if (scriptError) {
            throw new WidgetHtmlInputError(
              `widget_code has a JavaScript syntax error in inline script ${scriptError.scriptIndex} at line ${scriptError.line}, column ${scriptError.column}: ${scriptError.message}. Offending line: ${scriptError.snippet}. Fix the script and call show_widget again.`,
            );
          }
        }
      }
      const shouldPin = params.pin === true;
      if (pinnedOnly && !shouldPin) {
        throw new WidgetHtmlInputError("pin=true is required for this pinned-only widget surface");
      }
      const capabilities = normalizeBoardWidgetDeclared(
        params.capabilities as { netOrigins?: string[]; tools?: string[] } | undefined,
      );
      if (capabilities && !shouldPin) {
        throw new WidgetHtmlInputError("capabilities require pin=true");
      }
      const pinSessionKey = shouldPin ? options.agentSessionKey?.trim() : undefined;
      if (shouldPin && !pinSessionKey) {
        throw new WidgetHtmlInputError("pin requires an agent session");
      }
      const widgetCode = rawWidgetCode.trim();
      const presentation = asOptionalRecord(params.presentation);
      if (pinnedOnly && presentation?.target !== undefined) {
        throw new WidgetHtmlInputError(
          "presentation.target is unavailable for this pinned-only widget surface",
        );
      }
      const requestedTarget =
        readToolStringParam(presentation ?? {}, "target") ?? "assistant_message";
      if (
        isReport &&
        (!shouldPin ||
          rawWidgetCode ||
          requestedKind ||
          capabilities ||
          readToolStringParam(presentation ?? {}, "target"))
      ) {
        throw new WidgetHtmlInputError(
          "Reports require pin=true; omit widget_code, kind, capabilities, and presentation.target. Use HTML for an inline or executable widget",
        );
      }
      const report = isReport ? parseBoardReport(params.report) : undefined;
      if (kind !== "html" && !isReport) {
        throw new WidgetHtmlInputError(`unsupported widget kind ${JSON.stringify(kind)}`);
      }
      if (requestedTarget !== "assistant_message") {
        throw new WidgetHtmlInputError(
          `unsupported widget presentation target ${JSON.stringify(requestedTarget)}`,
        );
      }
      if (!inlineAvailable && !shouldPin) {
        throw new WidgetHtmlInputError(
          "inline widget hosting is disabled; set pin=true to place the widget on the session dashboard",
        );
      }
      const wrappedDocument = isReport ? "" : buildWidgetDocument(title, widgetCode);
      const hasPresentationRoute = !isReport && inlineAvailable;
      let pinnedText = "";
      let pinnedWidgetName: string | undefined;
      let capabilityState: BoardWidgetPutResult["widgets"][number]["grantState"] | undefined;
      if (pinSessionKey) {
        const explicitName = readToolStringParam(params, "name");
        const name = explicitName ?? slugWidgetName(title);
        const tab = readToolStringParam(params, "tab");
        const size = readToolStringParam(params, "size");
        const frame = readToolStringParam(presentation ?? {}, "frame");
        const after = readToolStringParam(params, "after");
        const pinnedTitle = truncateCodePoints(title, 80);
        if (!isReport) {
          assertPinnedWidgetDocumentSize(
            buildWidgetDocument(pinnedTitle, widgetCode, {
              connectOrigins: capabilities?.netOrigins,
            }),
          );
        }
        if (hasPresentationRoute) {
          assertWidgetHtmlSize(wrappedDocument, WIDGET_HTML_MAX_UTF8_BYTES, {
            inputName: "widget document after wrapping",
          });
        }
        const snapshot = await gatewayCall<BoardWidgetPutResult>("board.widget.put", {
          sessionKey: pinSessionKey,
          agentId: options.agentId,
          name,
          title: pinnedTitle,
          // The Gateway owns the board document shell so agent-authored bytes
          // can never run before its user-activation and bridge bootstrap.
          content: report
            ? { kind: "plugin", pluginKind: BOARD_REPORT_WIDGET_KIND, props: report }
            : { kind: "html", html: widgetCode },
          ...(frame ? { presentation: frame } : {}),
          ...(capabilities ? { declared: capabilities } : {}),
          ...(!explicitName ? { generatedIdentity: generatedWidgetIdentity(title, name) } : {}),
          ...(tab || size || after
            ? {
                placement: {
                  ...(tab ? { tabId: tab } : {}),
                  ...(size ? { size } : {}),
                  ...(after ? { after } : {}),
                },
              }
            : {}),
        });
        pinnedWidgetName = snapshot.resolvedWidgetName;
        const widget = snapshot.widgets.find(
          (candidate) => candidate.name === snapshot.resolvedWidgetName,
        );
        if (!widget) {
          throw new WidgetHtmlInputError(
            "Dashboard did not return the pinned widget; read the board and retry.",
          );
        }
        capabilityState = widget.grantState;
        pinnedText = `pinned to dashboard tab ${widget.tabId} as ${
          snapshot.resolvedWidgetName
        }${size ? ` (${size})` : ""}`;
        if (capabilityState === "pending") {
          pinnedText +=
            "; capabilities pending: ask the operator to review and approve the dashboard permission card";
        }
        if (capabilityState === "rejected") {
          pinnedText +=
            "; capabilities rejected: review the requested access and session permission policy with the operator before retrying";
        }
        if (capabilityState === "granted") {
          pinnedText += "; capabilities granted";
        }
      } else if (hasPresentationRoute) {
        assertWidgetHtmlSize(wrappedDocument, WIDGET_HTML_MAX_UTF8_BYTES, {
          inputName: "widget document after wrapping",
        });
      }
      if (!hasPresentationRoute) {
        return jsonResult({
          status:
            capabilityState === "pending" || capabilityState === "rejected"
              ? capabilityState
              : "pinned",
          boardWidgetName: pinnedWidgetName,
          capabilityState,
          text: `Widget ${pinnedText}. Open this dashboard tab in Control UI to view it.`,
        });
      }
      let document: Awaited<ReturnType<typeof createCanvasDocument>> | undefined;
      const hostDocument = async () =>
        (document ??= await createCanvasDocument(
          {
            title,
            html: wrappedDocument,
            surface: "assistant_message",
            retentionScope: resolveRetentionScope(options),
            // Direct navigation must not run widget script as the Control UI origin.
            cspSandbox: "scripts",
          },
          {
            stateDir: options.stateDir,
            maxDocumentsPerScope: WIDGET_MAX_PER_SCOPE,
          },
        ));

      const hosted = await hostDocument();
      return jsonResult({
        kind: "canvas",
        ...(capabilityState ? { capabilityState } : {}),
        presentation: {
          target: "assistant_message",
          title,
          sandbox: "scripts",
        },
        view: {
          id: hosted.id,
          url: hosted.entryUrl,
          ...(pinnedWidgetName ? { boardWidgetName: pinnedWidgetName } : {}),
        },
        text: `Widget hosted at ${hosted.entryUrl}${pinnedText ? `; ${pinnedText}` : ""}`,
      });
    },
  };
}
