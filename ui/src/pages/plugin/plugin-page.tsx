import { createMemo, Match, Show, Switch } from "solid-js";
import { LoadingState } from "../../components/solid/loading-state.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { CustomPluginUiDisabled } from "../../plugins/control-ui-disabled.solid.tsx";
import { PluginContribution } from "../../plugins/control-ui-view.solid.tsx";

export type PluginPageProps = {
  pluginId?: string;
  tabId?: string;
  params?: Readonly<Record<string, string>>;
};

function PluginPageContent(props: PluginPageProps, host: HTMLElement) {
  const context = useApplication();
  const gateway = projectOwner(context.gateway, (owner) => owner.snapshot);
  const plugins = projectOwner(context.plugins, (owner) => owner);
  host.style.display = "contents";
  const key = () => `${props.pluginId}/${props.tabId}`;
  const contribution = createMemo(() =>
    plugins
      .read()
      .registrations("pages")
      .some((entry) => entry.key === key()),
  );
  const loading = () =>
    gateway.read().phase !== "connected" || plugins.read().isLoading(props.pluginId ?? "");
  const failure = () => plugins.read().errors.find((entry) => entry.pluginId === props.pluginId);
  return (
    <Switch>
      <Match when={contribution()}>
        <PluginContribution kind="pages" contributionKey={key()} props={props.params ?? {}} />
      </Match>
      <Match when={loading()}>
        <LoadingState />
      </Match>
      <Match when={!contribution() && !loading()}>
        <section class="card lazy-view-state" role="status">
          <Show
            when={failure()?.code === "custom-plugin-ui-disabled"}
            fallback={
              <>
                <div class="card-title">{t("pluginTabs.unavailableTitle")}</div>
                <div class="card-sub">
                  {failure()?.message ?? t("pluginTabs.unavailableSubtitle")}
                </div>
              </>
            }
          >
            <CustomPluginUiDisabled context={context} pluginId={props.pluginId ?? ""} />
          </Show>
        </section>
      </Match>
    </Switch>
  );
}

export const PluginPage = defineSolidBridge<PluginPageProps>(
  "openclaw-plugin-page",
  PluginPageContent,
  {
    properties: {
      pluginId: { default: "", attribute: false },
      tabId: { default: "", attribute: false },
      params: { default: {}, attribute: false },
    },
  },
);

export type PluginPageElement = SolidBridgeElement<PluginPageProps>;
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-plugin-page": PluginPageElement;
  }
}
