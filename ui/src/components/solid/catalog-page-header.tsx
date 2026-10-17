import type { JSX } from "@solidjs/web";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import "../../styles/hub-tabs.css";

export function CatalogPageHeader(props: {
  title: string;
  subtitle?: JSX.Element;
  tabs?: JSX.Element;
  actions?: JSX.Element;
  class?: string;
}) {
  return (
    <ShellLayoutBoundary traits={{ hubHeader: true }}>
      <section
        class={[
          "content-header content-header--stacked content-header--settings content-header--page hub-page-header hub-page-header--stacked catalog-page-header",
          props.class,
          { "catalog-page-header--tabs": Boolean(props.tabs) },
        ]}
      >
        <div class="hub-page-header__title">
          <h1 class="page-title">{props.title}</h1>
          {props.subtitle && <div class="page-subtitle">{props.subtitle}</div>}
        </div>
        {props.tabs && <div class="hub-page-header__tabs">{props.tabs}</div>}
        {props.actions && <div class="hub-page-header__actions">{props.actions}</div>}
      </section>
    </ShellLayoutBoundary>
  );
}
