import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  PRESENTATION_CHANGED_EVENT,
  type PresentationBinding,
  type PresentationValue,
} from "../lib/presentation.ts";
import { listen } from "../lib/reactive/listener.ts";
import { MarkdownBlocks } from "./markdown-blocks-owner.ts";

function createPresentationReader(onHide: () => void) {
  let binding: PresentationBinding | undefined;
  let stop: (() => void) | undefined;
  const changed = () => {
    if (binding?.isPresented() === false) {
      onHide();
    }
  };
  onCleanup(() => stop?.());
  return (value: PresentationValue) => {
    const next = typeof value === "boolean" ? undefined : value;
    if (binding?.owner !== next?.owner) {
      stop?.();
      stop = next && listen(next.owner, PRESENTATION_CHANGED_EVENT, changed);
    }
    binding = next;
    return typeof value === "boolean" ? value : value.isPresented();
  };
}

export function markdownBlocksRef(
  presented: () => PresentationValue,
): (element: HTMLElement) => void {
  const [element, setElement] = createSignal<HTMLElement>();
  const owner = createMemo(() => {
    const root = element();
    const current = root && new MarkdownBlocks(root);
    onCleanup(() => current?.dispose());
    return current;
  });
  const readPresentation = createPresentationReader(() => owner()?.update(false));
  createEffect(
    () => [owner(), presented()] as const,
    ([current, value]) => {
      const active = readPresentation(value);
      current?.update(active);
    },
  );
  return setElement;
}
