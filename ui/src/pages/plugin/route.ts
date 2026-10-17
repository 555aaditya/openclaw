import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";

type PluginTabRef = {
  pluginId: string;
  id: string;
};

export function pluginTabRefFromSearch(search: string): PluginTabRef {
  const params = new URLSearchParams(search);
  return {
    pluginId: params.get("plugin")?.trim() ?? "",
    id: params.get("id")?.trim() ?? "",
  };
}

/** Stable key for one tab; ids are only unique per plugin, so both parts matter. */
export function pluginTabKey(ref: PluginTabRef): string {
  return `${ref.pluginId}/${ref.id}`;
}

function pluginPageParams(search: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...new URLSearchParams(search)]
      .filter(([key]) => key.startsWith("p."))
      .map(([key, value]) => [key.slice(2), value]),
  );
}

export const page = definePage({
  ...routePageSpec("plugin"),
  loaderDeps: (_context: ApplicationContext, location) =>
    JSON.stringify([
      pluginTabKey(pluginTabRefFromSearch(location.search)),
      pluginPageParams(location.search),
    ]),
  loader: (_context: ApplicationContext, options) => ({
    ...pluginTabRefFromSearch(options.location.search),
    params: pluginPageParams(options.location.search),
  }),
  component: () =>
    import("./plugin-page.tsx").then((module) => ({
      header: true,
      renderSolid: (
        props: SolidRouteProps<PluginTabRef & { params: Readonly<Record<string, string>> }>,
      ) =>
        createComponent(module.PluginPage, {
          get pluginId() {
            return props.data?.pluginId ?? "";
          },
          get tabId() {
            return props.data?.id ?? "";
          },
          get params() {
            return props.data?.params ?? {};
          },
        }),
    })),
});
