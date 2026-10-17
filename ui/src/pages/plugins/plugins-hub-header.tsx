import type { JSX } from "@solidjs/web";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { CatalogPageHeader } from "../../components/solid/catalog-page-header.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { PLUGINS_HUB_DOCS_URLS, PLUGINS_HUB_PANEL_ID, type PluginsHubTab } from "./plugins-hub.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

type PluginsHubHeaderProps = {
  active: PluginsHubTab;
  onSelect: (tab: PluginsHubTab) => void;
  secondaryAction?: {
    label: string;
    icon?: JSX.Element;
    onClick: () => void;
  };
};

export function PluginsHubHeader(props: PluginsHubHeaderProps) {
  return (
    <CatalogPageHeader
      class="plugins-hub-header"
      title={titleForRoute(props.active, t)}
      subtitle={
        <>
          {subtitleForRoute(props.active, t)}{" "}
          <LearnMoreLink url={PLUGINS_HUB_DOCS_URLS[props.active]} />
        </>
      }
      tabs={
        <HubTabs
          id="plugins"
          active={props.active}
          tabs={[
            { value: "plugins", label: t("tabs.plugins") },
            { value: "skills", label: t("tabs.skills") },
            { value: "skill-workshop", label: t("tabs.skillWorkshop") },
          ]}
          ariaLabel={t("pluginsPage.hubTablistLabel")}
          panelId={PLUGINS_HUB_PANEL_ID}
          class="plugins-tabs"
          onSelect={props.onSelect}
        />
      }
      actions={
        props.secondaryAction && (
          <button
            type="button"
            class={[
              "btn btn--sm plugins-hub-header__secondary oc-action oc-action-secondary",
              { "btn--icon": Boolean(props.secondaryAction.icon) },
            ]}
            aria-label={props.secondaryAction.label}
            title={props.secondaryAction.icon ? props.secondaryAction.label : undefined}
            onClick={() => props.secondaryAction?.onClick()}
          >
            {props.secondaryAction.icon ?? props.secondaryAction.label}
          </button>
        )
      }
    />
  );
}
