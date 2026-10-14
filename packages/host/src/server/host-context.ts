// SPDX-License-Identifier: Apache-2.0
import {
  McpUiHostStylesSchema,
  type McpUiHostContext,
  type McpUiHostStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";

const DisplayModeSchema = z.enum(["inline", "fullscreen", "pip"]);

/** Runtime inputs used to construct the reference host's MCP Apps context. */
export const HostContextOptionsSchema = z
  .object({
    theme: z.enum(["light", "dark"]),
    locale: z.string().min(1).max(64),
    timeZone: z.string().min(1).max(64),
    displayMode: DisplayModeSchema,
    availableDisplayModes: z.array(DisplayModeSchema).min(1).max(3),
    maxWidth: z.number().int().min(1).max(4096),
    maxHeight: z.number().int().min(1).max(4096),
  })
  .strict()
  .superRefine((options, context) => {
    if (!options.availableDisplayModes.includes("inline")) {
      context.addIssue({
        code: "custom",
        path: ["availableDisplayModes"],
        message: "Inline display must be available.",
      });
    }
    if (!options.availableDisplayModes.includes(options.displayMode)) {
      context.addIssue({
        code: "custom",
        path: ["displayMode"],
        message: "The current display mode must be available.",
      });
    }
  });

/** Inferred inputs for the reference host's context builder. */
export type HostContextOptions = z.infer<typeof HostContextOptionsSchema>;

const colorVariables: readonly (readonly [string, string, string])[] = [
  ["--color-background-primary", "#ffffff", "#111827"],
  ["--color-background-secondary", "#f9fafb", "#1f2937"],
  ["--color-background-tertiary", "#f3f4f6", "#374151"],
  ["--color-background-inverse", "#111827", "#ffffff"],
  ["--color-background-ghost", "transparent", "transparent"],
  ["--color-background-info", "#eff6ff", "#172554"],
  ["--color-background-danger", "#fef2f2", "#450a0a"],
  ["--color-background-success", "#f0fdf4", "#052e16"],
  ["--color-background-warning", "#fffbeb", "#451a03"],
  ["--color-background-disabled", "#f3f4f6", "#374151"],
  ["--color-text-primary", "#111827", "#f9fafb"],
  ["--color-text-secondary", "#4b5563", "#d1d5db"],
  ["--color-text-tertiary", "#6b7280", "#9ca3af"],
  ["--color-text-inverse", "#ffffff", "#111827"],
  ["--color-text-ghost", "#9ca3af", "#6b7280"],
  ["--color-text-info", "#1d4ed8", "#93c5fd"],
  ["--color-text-danger", "#b91c1c", "#fca5a5"],
  ["--color-text-success", "#15803d", "#86efac"],
  ["--color-text-warning", "#a16207", "#fcd34d"],
  ["--color-text-disabled", "#9ca3af", "#6b7280"],
  ["--color-border-primary", "#d1d5db", "#4b5563"],
  ["--color-border-secondary", "#e5e7eb", "#374151"],
  ["--color-border-tertiary", "#f3f4f6", "#1f2937"],
  ["--color-border-inverse", "#111827", "#ffffff"],
  ["--color-border-ghost", "transparent", "transparent"],
  ["--color-border-info", "#93c5fd", "#1e40af"],
  ["--color-border-danger", "#fca5a5", "#991b1b"],
  ["--color-border-success", "#86efac", "#166534"],
  ["--color-border-warning", "#fcd34d", "#92400e"],
  ["--color-border-disabled", "#e5e7eb", "#374151"],
  ["--color-ring-primary", "#2563eb", "#60a5fa"],
  ["--color-ring-secondary", "#6b7280", "#9ca3af"],
  ["--color-ring-inverse", "#ffffff", "#111827"],
  ["--color-ring-info", "#3b82f6", "#93c5fd"],
  ["--color-ring-danger", "#dc2626", "#f87171"],
  ["--color-ring-success", "#16a34a", "#4ade80"],
  ["--color-ring-warning", "#d97706", "#fbbf24"],
];

const fixedVariables: Readonly<Record<string, string>> = {
  "--font-sans": "system-ui, sans-serif",
  "--font-mono": "ui-monospace, monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "0.75rem",
  "--font-text-sm-size": "0.875rem",
  "--font-text-md-size": "1rem",
  "--font-text-lg-size": "1.125rem",
  "--font-heading-xs-size": "1rem",
  "--font-heading-sm-size": "1.125rem",
  "--font-heading-md-size": "1.25rem",
  "--font-heading-lg-size": "1.5rem",
  "--font-heading-xl-size": "1.875rem",
  "--font-heading-2xl-size": "2.25rem",
  "--font-heading-3xl-size": "3rem",
  "--font-text-xs-line-height": "1rem",
  "--font-text-sm-line-height": "1.25rem",
  "--font-text-md-line-height": "1.5rem",
  "--font-text-lg-line-height": "1.75rem",
  "--font-heading-xs-line-height": "1.5rem",
  "--font-heading-sm-line-height": "1.75rem",
  "--font-heading-md-line-height": "1.75rem",
  "--font-heading-lg-line-height": "2rem",
  "--font-heading-xl-line-height": "2.25rem",
  "--font-heading-2xl-line-height": "2.5rem",
  "--font-heading-3xl-line-height": "3rem",
  "--border-radius-xs": "0.125rem",
  "--border-radius-sm": "0.25rem",
  "--border-radius-md": "0.375rem",
  "--border-radius-lg": "0.5rem",
  "--border-radius-xl": "0.75rem",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 0 0 1px rgb(0 0 0 / 0.05)",
  "--shadow-sm": "0 1px 2px rgb(0 0 0 / 0.08)",
  "--shadow-md": "0 4px 6px rgb(0 0 0 / 0.12)",
  "--shadow-lg": "0 10px 15px rgb(0 0 0 / 0.16)",
};

function styleVariable(name: string, theme: "light" | "dark"): string {
  const color = colorVariables.find(([key]) => key === name);
  if (color !== undefined) {
    return theme === "dark" ? color[2] : color[1];
  }
  return fixedVariables[name] ?? "";
}

function createStyles(theme: "light" | "dark"): McpUiHostStyles {
  const variables: Record<string, string> = {};
  for (const [name] of colorVariables) {
    variables[name] = styleVariable(name, theme);
  }
  for (const name of Object.keys(fixedVariables)) {
    variables[name] = styleVariable(name, theme);
  }
  const styles = McpUiHostStylesSchema.parse({ variables });
  if (styles.variables === undefined) {
    throw new Error("Host style variables are unavailable.");
  }
  return { variables: styles.variables };
}

/**
 * Builds the documented MCP Apps host context, including bounded sizing and theme variables.
 *
 * @param input - Browser-derived theme, locale, time zone, display modes, and size limits.
 * @returns Host context to include in `ui/initialize` and subsequent context updates.
 */
export function createHostContext(input: unknown): McpUiHostContext {
  const options = HostContextOptionsSchema.parse(input);
  return {
    theme: options.theme,
    styles: createStyles(options.theme),
    displayMode: options.displayMode,
    availableDisplayModes: [...options.availableDisplayModes],
    containerDimensions: { maxWidth: options.maxWidth, maxHeight: options.maxHeight },
    locale: options.locale,
    timeZone: options.timeZone,
    platform: "web",
  };
}
