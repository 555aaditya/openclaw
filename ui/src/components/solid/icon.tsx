import { dynamic, isServer, type JSX } from "@solidjs/web";
import { brandIconData, type BrandIconName } from "../icon-data-brand.ts";
import { keyboardIconData, type KeyboardIconSymbol } from "../icon-data-tools.ts";
import { strokeIconData, type IconData, type IconNode } from "../icon-data-types.ts";
import { iconData, type IconName } from "../icon-data.ts";

export type { BrandIconName } from "../icon-data-brand.ts";
export { hasKeyboardIcon, type KeyboardIconSymbol } from "../icon-data-tools.ts";
export type { IconName } from "../icon-data.ts";

type IconPresentation = {
  class?: string;
  style?: string | JSX.CSSProperties;
  "aria-label"?: string;
};

// Keyboard icons wrap their data on each read; the immutable child array is the cache identity.
const iconShapes = new WeakMap<readonly IconNode[], readonly SVGElement[]>();

function createIconShape([tag, attributes, children]: IconNode): SVGElement {
  const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    shape.setAttribute(name, String(value));
  }
  shape.append(...(children?.map(createIconShape) ?? []));
  return shape;
}

function renderIconShapes(nodes: readonly IconNode[]): JSX.Element {
  if (isServer) {
    return nodes.map(([tag, attributes, children]) => {
      const Shape = dynamic(() => tag, { static: true });
      return <Shape {...attributes}>{children && renderIconShapes(children)}</Shape>;
    });
  }
  let shapes = iconShapes.get(nodes);
  if (!shapes) {
    shapes = nodes.map(createIconShape);
    iconShapes.set(nodes, shapes);
  }
  return shapes.map((shape) => shape.cloneNode(true));
}

function IconSvg(props: IconPresentation & { data: IconData }) {
  return (
    <svg
      {...props.data.attributes}
      class={[props.data.attributes.class, props.class]}
      style={props.style}
      aria-hidden={props["aria-label"] ? undefined : "true"}
      aria-label={props["aria-label"]}
      role={props["aria-label"] ? "img" : undefined}
    >
      {renderIconShapes(props.data.children)}
    </svg>
  );
}

export function Icon(props: IconPresentation & { name: IconName }) {
  return <IconSvg {...props} data={iconData[props.name]} />;
}

export function KeyboardIcon(props: IconPresentation & { symbol: KeyboardIconSymbol }) {
  return <IconSvg {...props} data={strokeIconData(keyboardIconData[props.symbol])} />;
}

export function BrandIcon(props: IconPresentation & { name: BrandIconName }) {
  return <IconSvg {...props} data={brandIconData[props.name]} />;
}
