# Harness MCP App UI kit

`@rovinos/approval-app/src/kit/` is the shared browser-safe component and theme layer for harness MCP Apps. It provides token pills, elicitation forms, tables, timelines, status badges, meters, confirmation dialogs, URL displays, and empty/error states. Add each view under `src/views/<name>/index.ts`; the package build discovers these entries and emits one `dist/<name>.html` resource for each. Build integrations can also pass additional named entrypoints through `buildAllViewHtml({ entries })`.

## Host context and layout

Views should apply `applyHostContext(document.documentElement, app.getHostContext())` after the MCP Apps handshake and again when `hostcontextchanged` fires. The helper uses the host theme, supported CSS color variables, locale, time zone, display mode, and width limit. Missing context falls back to system light/dark preference, English strings, inline layout, and built-in color tokens. CSS values from host context are restricted to color literals before being applied.

The shared stylesheet adapts for `inline`, `fullscreen`, and `pip` modes, wraps long content, and supports screens as narrow as 320 px. It retains visible keyboard focus and disables animation and transitions when `prefers-reduced-motion` is enabled.

## Components and copy

Components accept text and values and place them in DOM nodes with `createElement` and `textContent`; tokenized sensitive values stay masked. URL display highlights the hostname without creating a link. Elicitation forms support object fields with string, number, integer, and boolean values, plus primitive enums; unsupported schemas render an error state.

All harness-authored user-visible copy is in `src/kit/strings.ts`. Use the formatting helpers for localized numbers, dates, durations, and message placeholders. The current catalog is English; additional translations can be added as catalog entries.

## Build and checks

Run `yarn workspace @rovinos/approval-app build` to produce the view resources. The build embeds script and style, hashes each document, rejects external URLs, and the unit tests enforce a 150 KiB gzip budget per view. Component tests cover hostile text, keyboard-operable controls, and axe checks in both built-in themes.

## Runs console

The `ui://harness/runs/v1` view lists run status, age, step counts, and pending approval counts. It refreshes on run-resource subscription updates when the host bridge supports them, and otherwise polls the app-visible `harness.runs.list` and `harness.runs.get` tools every five seconds. It pauses while hidden, backs off after tool errors, and provides cursor-based loading for older runs. The `list_runs` model-facing tool remains available to clients without MCP Apps support and links the resource through `_meta.ui.resourceUri`.

The console requests and displays metadata only until a person selects an approval. That action loads the validated approval payload through the app-only, approval-authorized `harness.approvals.get` tool and transitions to the approval view within the current iframe. Run details use the metadata projection; event content is never requested by the console.

## Run inspector

The `ui://harness/run/v1` view is linked from `get_run` and follows one run's event history as a timeline of model calls, tool calls and policy decisions, approval and input waits, checkpoints, compaction, subagent activity, budget events, and status changes. It shows aggregate step, token, and cost usage, plus limits and meters only where the event history records them. A subagent link opens the child run in the same view; pending approval and input actions open their existing review views.

Run metadata and the timeline contain no event content. The inspector requests recent tokenized content only after a person selects **Show tokenized content**; this app-only operation requires a token with `read_content` scope and does not resolve vault tokens. Raw-value reveal remains a separate audited operation. The content response is limited to the latest 100 content-bearing events and indicates when older entries are omitted.

The view refreshes on run-resource notifications and falls back to polling when the host subscription is unavailable. Polling pauses while the document is hidden and resumes when it becomes visible. A run's configured root budget limits are not persisted in the event log, so the inspector reports usage and only displays meters for limits recorded by budget events or subagent spawn events.
