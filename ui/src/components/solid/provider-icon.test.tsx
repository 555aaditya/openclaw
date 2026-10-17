import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import type { CloudProfileIdentity } from "../provider-icon-data.ts";
import { Icon } from "./icon.tsx";
import { CloudProfileIcon, ProviderBrandIcon, ProviderFallbackIcon } from "./provider-icon.tsx";

afterEach(cleanup);

function svgGeometry(element: Element | null): unknown {
  return element
    ? {
        tag: element.localName,
        namespace: element.namespaceURI,
        attributes: Object.fromEntries(
          [...element.attributes]
            .filter((attribute) => attribute.name !== "aria-hidden")
            .map((attribute) => [attribute.name, attribute.value]),
        ),
        children: [...element.children].map(svgGeometry),
      }
    : null;
}

it("updates provider brands, aliases, and grapheme fallbacks without retaining stale assets", () => {
  const [provider, setProvider] = createSignal("google");
  const view = render(() => <ProviderBrandIcon provider={provider()} class="picker-icon" />);
  const icon = () => view.container.querySelector<HTMLElement>(".provider-brand-icon")!;
  expect(icon().dataset.providerIcon).toBe("gemini");
  expect(icon().style.getPropertyValue("--provider-icon-url")).toContain("ProviderIcon-gemini.svg");
  expect(icon().classList.contains("picker-icon")).toBe(true);

  setProvider("👩‍💻 Studio");
  flush();
  expect(icon().textContent).toBe("👩‍💻");
  expect(icon().dataset.providerIcon).toBeUndefined();
  expect(icon().style.getPropertyValue("--provider-icon-url")).toBe("");
  expect(icon().classList.contains("provider-brand-icon--fallback")).toBe(true);

  setProvider("acp-copilot");
  flush();
  expect(icon().dataset.providerIcon).toBe("copilot");
  expect(icon().classList.contains("provider-brand-icon--fallback")).toBe(false);
});

it("updates paired-device and historical provider icons without retaining stale geometry", () => {
  const [profile, setProfile] = createSignal<CloudProfileIdentity>({ providerId: "device" });
  const view = render(() => (
    <>
      <CloudProfileIcon profile={profile()} />
      <ProviderFallbackIcon label="   " />
    </>
  ));
  const server = render(() => <Icon name="server" />);
  const cloud = render(() => <Icon name="cloud" />);
  const geometry = () => svgGeometry(view.container.querySelector(".cloud-profile-icon svg"));
  expect(geometry()).toEqual(svgGeometry(server.container.querySelector("svg")));
  expect(view.container.querySelector(".provider-brand-icon--fallback")?.textContent).toBe("?");

  setProfile({ providerId: "google" });
  flush();
  expect(geometry()).toEqual(svgGeometry(cloud.container.querySelector("svg")));
  expect(view.container.querySelector("[data-provider-icon]")).toBeNull();

  setProfile({ providerId: "device" });
  flush();
  expect(geometry()).toEqual(svgGeometry(server.container.querySelector("svg")));
});

it.each([
  ["device", "server"],
  ["machine0", "cloud"],
  ["incus", "cloud"],
  ["docker", "cloud"],
  ["constructor", "cloud"],
] as const)("uses shared generic geometry for %s", (providerId, expectedIcon) => {
  const actual = render(() => <CloudProfileIcon profile={{ providerId }} />);
  const expected = render(() => <Icon name={expectedIcon} />);
  expect(svgGeometry(actual.container.querySelector("svg"))).toEqual(
    svgGeometry(expected.container.querySelector("svg")),
  );
  expect(actual.container.querySelector("svg")?.closest('[aria-hidden="true"]')).not.toBeNull();
  expect(actual.container.querySelector("[data-provider-icon]")).toBeNull();
});
