# Harness MCP App UI kit

`@harness/approval-app/src/kit/` is the shared browser-safe component and theme layer for harness MCP Apps. It provides token pills, elicitation forms, tables, timelines, status badges, meters, confirmation dialogs, URL displays, and empty/error states. Add each view under `src/views/<name>/index.ts`; the package build discovers these entries and emits one `dist/<name>.html` resource for each. Build integrations can also pass additional named entrypoints through `buildAllViewHtml({ entries })`.

## Host context and layout

Views should apply `applyHostContext(document.documentElement, app.getHostContext())` after the MCP Apps handshake and again when `hostcontextchanged` fires. The helper uses the host theme, supported CSS color variables, locale, time zone, display mode, and width limit. Missing context falls back to system light/dark preference, English strings, inline layout, and built-in color tokens. CSS values from host context are restricted to color literals before being applied.

The shared stylesheet adapts for `inline`, `fullscreen`, and `pip` modes, wraps long content, and supports screens as narrow as 320 px. It retains visible keyboard focus and disables animation and transitions when `prefers-reduced-motion` is enabled.

## Components and copy

Components accept text and values and place them in DOM nodes with `createElement` and `textContent`; tokenized sensitive values stay masked. URL display highlights the hostname without creating a link. Elicitation forms support object fields with string, number, integer, and boolean values, plus primitive enums; unsupported schemas render an error state.

All harness-authored user-visible copy is in `src/kit/strings.ts`. Use the formatting helpers for localized numbers, dates, durations, and message placeholders. The current catalog is English; additional translations can be added as catalog entries.

## Build and checks

Run `yarn workspace @harness/approval-app build` to produce the view resources. The build embeds script and style, hashes each document, rejects external URLs, and the unit tests enforce a 150 KiB gzip budget per view. Component tests cover hostile text, keyboard-operable controls, and axe checks in both built-in themes.
