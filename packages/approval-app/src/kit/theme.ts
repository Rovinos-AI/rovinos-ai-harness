// SPDX-License-Identifier: Apache-2.0
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";

/** MCP Apps display modes supported by the host. */
export type HarnessDisplayMode = "inline" | "fullscreen" | "pip";
/** Theme names supported by MCP Apps hosts. */
export type HarnessTheme = "light" | "dark";

/** Host context fields consumed by the shared view theme adapter. */
export interface HarnessThemeContext {
  readonly theme?: HarnessTheme;
  readonly displayMode?: HarnessDisplayMode;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly containerDimensions?: {
    readonly maxWidth?: number;
    readonly maxHeight?: number;
  };
  readonly styles?: {
    readonly variables?: Readonly<Record<string, string | undefined>>;
  };
}

/** Resolved theme and locale values applied to the document root. */
export interface ResolvedTheme {
  readonly theme: HarnessTheme;
  readonly displayMode: HarnessDisplayMode;
  readonly locale: string;
  readonly timeZone: string;
  readonly variables: Readonly<Record<string, string>>;
}

const palette = {
  light: {
    "--color-background-primary": "#ffffff",
    "--color-background-secondary": "#f9fafb",
    "--color-background-tertiary": "#f3f4f6",
    "--color-text-primary": "#172033",
    "--color-text-secondary": "#475569",
    "--color-text-disabled": "#475569",
    "--color-border-primary": "#475569",
    "--color-ring-primary": "#0757c9",
    "--color-background-success": "#f0fdf4",
    "--color-text-success": "#166534",
    "--color-background-warning": "#fffbeb",
    "--color-text-warning": "#854d0e",
    "--color-background-danger": "#fef2f2",
    "--color-text-danger": "#b91c1c",
  },
  dark: {
    "--color-background-primary": "#121826",
    "--color-background-secondary": "#1f2937",
    "--color-background-tertiary": "#273449",
    "--color-text-primary": "#f1f5f9",
    "--color-text-secondary": "#cbd5e1",
    "--color-text-disabled": "#cbd5e1",
    "--color-border-primary": "#94a3b8",
    "--color-ring-primary": "#93c5fd",
    "--color-background-success": "#052e16",
    "--color-text-success": "#bbf7d0",
    "--color-background-warning": "#451a03",
    "--color-text-warning": "#fde68a",
    "--color-background-danger": "#450a0a",
    "--color-text-danger": "#fecaca",
  },
} as const;

const colorVariables = Object.keys(palette.light);
const safeColor = /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?)\([\d.%\s,+/-]+\)|transparent)$/iu;

function isWindowMatchMedia(
  value: unknown,
): value is (this: Window, query: string) => MediaQueryList {
  return typeof value === "function";
}

function prefersDark(document: Document): boolean {
  const view = document.defaultView;
  if (view === null) {
    return false;
  }
  const matchMedia: unknown = Reflect.get(view, "matchMedia");
  if (!isWindowMatchMedia(matchMedia)) {
    return false;
  }
  return matchMedia.call(view, "(prefers-color-scheme: dark)").matches;
}

function safeHostColors(
  variables: Readonly<Record<string, string | undefined>> | undefined,
  fallback: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = { ...fallback };
  for (const variable of colorVariables) {
    const candidate = variables?.[variable];
    if (candidate !== undefined && safeColor.test(candidate)) {
      result[variable] = candidate;
    }
  }
  return result;
}

/** Resolves host context and safe CSS color variables with built-in theme fallbacks. */
export function resolveTheme(
  context: HarnessThemeContext | McpUiHostContext | undefined,
  document: Document,
): ResolvedTheme {
  const theme = context?.theme ?? (prefersDark(document) ? "dark" : "light");
  const displayMode = context?.displayMode ?? "inline";
  const cssVariables = safeHostColors(context?.styles?.variables, palette[theme]);
  const hostLocale = context?.locale;
  const documentLocale = document.documentElement.lang;
  let locale = "en";
  if (hostLocale !== undefined && hostLocale.length > 0) {
    locale = hostLocale;
  } else if (documentLocale.length > 0) {
    locale = documentLocale;
  }
  return {
    theme,
    displayMode,
    locale,
    timeZone: context?.timeZone ?? "UTC",
    variables: cssVariables,
  };
}

/** Applies host theme and display-mode context to a view root. */
export function applyHostContext(
  root: HTMLElement,
  context?: HarnessThemeContext | McpUiHostContext,
): ResolvedTheme {
  const resolved = resolveTheme(context, root.ownerDocument);
  root.setAttribute("data-theme", resolved.theme);
  root.setAttribute("data-display-mode", resolved.displayMode);
  for (const [name, value] of Object.entries(resolved.variables)) {
    root.style.setProperty(name, value);
  }
  const dimensions = context?.containerDimensions;
  const maxWidth =
    dimensions !== undefined && "maxWidth" in dimensions ? dimensions.maxWidth : undefined;
  if (maxWidth !== undefined && Number.isSafeInteger(maxWidth) && maxWidth >= 320) {
    root.style.setProperty("--host-max-width", `${String(Math.min(maxWidth, 4096))}px`);
  } else {
    root.style.removeProperty("--host-max-width");
  }
  root.ownerDocument.documentElement.setAttribute("lang", resolved.locale);
  return resolved;
}
