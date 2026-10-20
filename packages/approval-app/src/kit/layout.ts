// SPDX-License-Identifier: Apache-2.0
import type { HarnessDisplayMode } from "./theme.js";

/** Applies a display mode to the app root; the CSS kit adapts within the host bounds. */
export function setDisplayMode(root: HTMLElement, mode: HarnessDisplayMode): void {
  root.setAttribute("data-display-mode", mode);
}

/** Returns a responsive inline style rule for a host-provided maximum width. */
export function hostWidth(maxWidth: number | undefined): string | undefined {
  if (maxWidth === undefined || !Number.isSafeInteger(maxWidth) || maxWidth < 320) {
    return undefined;
  }
  return `${String(Math.min(maxWidth, 4096))}px`;
}
