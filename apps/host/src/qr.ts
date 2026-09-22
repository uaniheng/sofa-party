import { renderSVG } from "uqr";

export function qrSvg(text: string): string {
  return renderSVG(text, { border: 2 });
}
