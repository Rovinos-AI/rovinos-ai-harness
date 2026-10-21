// SPDX-License-Identifier: Apache-2.0
import {
  RunConsoleDetailSchema,
  RunConsoleListSchema,
  RunStatus,
  type RunConsoleDetail,
  type RunConsoleRun,
} from "@harness/schemas/browser";
import type { AppTelemetry } from "@harness/app-telemetry";
import { createEmptyState, createStatusBadge } from "../../kit/components.js";
import { formatMessage, formatNumber, getStrings } from "../../kit/strings.js";

const listTool = "harness.runs.list";
const detailTool = "harness.runs.get";
const approvalResource = "ui://harness/approval/v1";
const pollIntervalMs = 5_000;
const maxPollIntervalMs = 60_000;

type RunsTelemetry = AppTelemetry<readonly ["ui.render", "ui.error", "ui.interaction"]>;

/** Minimal app bridge surface used by the runs console. */
export interface RunsConsoleBridge {
  callTool(
    name: typeof listTool | typeof detailTool,
    args: Record<string, unknown>,
  ): Promise<{
    readonly isError?: boolean | undefined;
    readonly structuredContent?: unknown;
  }>;
  openApproval(approvalId: string): Promise<void>;
}

/** Injectable browser and telemetry dependencies for the console view. */
export interface RunsConsoleOptions {
  readonly bridge: RunsConsoleBridge;
  readonly telemetry: RunsTelemetry;
  readonly now?: () => number;
}

/** Mounted runs console controls, metadata detail inspection, and adaptive polling. */
export interface RunsConsoleView {
  refresh(): Promise<void>;
  dispose(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function relativeAge(createdAt: number, now: number, locale: string): string {
  const seconds = Math.floor(Math.max(0, now - createdAt) / 1000);
  const unit =
    seconds < 60
      ? { amount: seconds, unit: "second" as const }
      : seconds < 3600
        ? { amount: Math.floor(seconds / 60), unit: "minute" as const }
        : seconds < 86_400
          ? { amount: Math.floor(seconds / 3600), unit: "hour" as const }
          : { amount: Math.floor(seconds / 86_400), unit: "day" as const };
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      -unit.amount,
      unit.unit,
    );
  } catch {
    return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-unit.amount, unit.unit);
  }
}

function statusKind(
  status: RunConsoleRun["status"],
): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (status) {
    case "completed":
      return "success";
    case "pending":
    case "suspended":
      return "warning";
    case "failed":
      return "danger";
    case "running":
      return "info";
    case "cancelled":
      return "neutral";
  }
}

function resultValue(result: {
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown;
}): unknown {
  if (result.isError === true || result.structuredContent === undefined) {
    throw new Error("runs_console_tool_failed");
  }
  return result.structuredContent;
}

function appendMetadata(document: Document, parent: HTMLElement, label: string, value: string): void {
  parent.append(element(document, "dt", label), element(document, "dd", value));
}

function renderDetail(
  host: HTMLElement,
  detail: RunConsoleDetail,
  strings: ReturnType<typeof getStrings>,
  locale: string,
  onOpenApproval: (approvalId: string) => void,
): void {
  const document = host.ownerDocument;
  const section = element(document, "section");
  section.setAttribute("aria-labelledby", "run-detail-heading");
  section.append(element(document, "h2", strings.runDetailsTitle));
  section.lastElementChild?.setAttribute("id", "run-detail-heading");
  const metadata = element(document, "dl");
  appendMetadata(document, metadata, strings.runDetailStatus, detail.status);
  appendMetadata(document, metadata, strings.runDetailSteps, formatNumber(detail.steps, locale));
  appendMetadata(
    document,
    metadata,
    strings.runDetailInputTokens,
    formatNumber(detail.usage.inputTokens, locale),
  );
  appendMetadata(
    document,
    metadata,
    strings.runDetailOutputTokens,
    formatNumber(detail.usage.outputTokens, locale),
  );
  appendMetadata(
    document,
    metadata,
    strings.runDetailCost,
    formatNumber(detail.usage.costMicros, locale),
  );
  appendMetadata(
    document,
    metadata,
    strings.runDetailApprovals,
    formatNumber(detail.pendingApprovals.length, locale),
  );
  section.append(metadata);
  for (const approval of detail.pendingApprovals) {
    const button = element(
      document,
      "button",
      formatMessage(strings.openApproval, { id: approval.approvalId }),
    );
    button.type = "button";
    button.addEventListener("click", () => onOpenApproval(approval.approvalId));
    section.append(button);
  }
  host.replaceChildren(section);
}

function renderRuns(
  host: HTMLElement,
  runs: readonly RunConsoleRun[],
  now: number,
  locale: string,
  strings: ReturnType<typeof getStrings>,
  onDetails: (run: RunConsoleRun) => void,
  onApproval: (run: RunConsoleRun) => void,
): void {
  const document = host.ownerDocument;
  if (runs.length === 0) {
    host.replaceChildren(createEmptyState(document, strings.noRunsTitle, strings.noRunsMessage));
    return;
  }
  const wrapper = element(document, "div");
  wrapper.className = "table-scroll";
  wrapper.tabIndex = 0;
  wrapper.setAttribute("aria-label", strings.runsConsoleDescription);
  const table = element(document, "table");
  table.append(element(document, "caption", strings.runsConsoleTitle));
  const head = element(document, "thead");
  const header = element(document, "tr");
  for (const label of [
    strings.runId,
    strings.runStatus,
    strings.runAge,
    strings.runSteps,
    strings.runApprovals,
    strings.viewRunDetails,
  ]) {
    const cell = element(document, "th", label);
    cell.scope = "col";
    header.append(cell);
  }
  head.append(header);
  const body = element(document, "tbody");
  for (const run of runs) {
    const row = element(document, "tr");
    row.append(
      element(document, "th", run.runId),
      element(document, "td"),
      element(document, "td", relativeAge(run.createdAt, now, locale)),
      element(document, "td", formatNumber(run.steps, locale)),
      element(document, "td"),
      element(document, "td"),
    );
    row.cells[0]?.setAttribute("scope", "row");
    row.cells[1]?.append(createStatusBadge(document, statusKind(run.status), run.status));
    const approvalCell = row.cells[4];
    if (approvalCell !== undefined) {
      if (run.pendingApprovals > 0) {
        const button = element(
          document,
          "button",
          formatMessage(strings.needsApproval, { count: run.pendingApprovals }, locale),
        );
        button.type = "button";
        button.addEventListener("click", () => onApproval(run));
        approvalCell.append(button);
      } else {
        approvalCell.textContent = formatNumber(0, locale);
      }
    }
    const detailsCell = row.cells[5];
    if (detailsCell !== undefined) {
      const button = element(document, "button", strings.viewRunDetails);
      button.type = "button";
      button.addEventListener("click", () => onDetails(run));
      detailsCell.append(button);
    }
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  host.replaceChildren(wrapper);
}

/** Mounts an accessible metadata-only runs console backed by MCP App bridge tools. */
export function createRunsConsoleView(
  container: HTMLElement,
  options: RunsConsoleOptions,
): RunsConsoleView {
  const document = container.ownerDocument;
  const window = document.defaultView;
  if (window === null) {
    throw new Error("runs_console_document_unavailable");
  }
  const now = options.now ?? (() => Date.now());
  const strings = getStrings(document.documentElement.lang);
  const main = element(document, "main");
  const heading = element(document, "h1", strings.runsConsoleTitle);
  heading.tabIndex = -1;
  main.append(heading, element(document, "p", strings.runsConsoleDescription));
  const filterLabel = element(document, "label", strings.runStatusFilter);
  const filter = element(document, "select");
  filter.id = "run-status-filter";
  filterLabel.htmlFor = filter.id;
  const allOption = element(document, "option", strings.allRunStatuses);
  allOption.value = "all";
  filter.append(allOption);
  for (const status of RunStatus.options) {
    const option = element(document, "option", status);
    option.value = status;
    filter.append(option);
  }
  main.append(filterLabel, filter);
  const refreshButton = element(document, "button", strings.refreshRuns);
  refreshButton.type = "button";
  main.append(refreshButton);
  const liveRegion = element(document, "p");
  liveRegion.setAttribute("role", "status");
  liveRegion.setAttribute("aria-live", "polite");
  liveRegion.textContent = strings.runsUpdated;
  main.append(liveRegion);
  const listHost = element(document, "section");
  listHost.setAttribute("aria-label", strings.runsConsoleTitle);
  const detailHost = element(document, "section");
  detailHost.setAttribute("aria-live", "polite");
  main.append(listHost, detailHost);
  container.replaceChildren(main);
  heading.focus();

  let timer: number | undefined;
  let pollDelay = pollIntervalMs;
  let refreshing = false;
  let disposed = false;
  let hasRendered = false;
  const recordInteraction = (): void => {
    options.telemetry.record("ui.interaction", { kind: "click", count: 1 });
  };
  const clearTimer = (): void => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };
  const schedule = (delay: number): void => {
    clearTimer();
    if (!disposed && document.visibilityState !== "hidden") {
      timer = window.setTimeout(() => {
        timer = undefined;
        void refresh();
      }, delay);
    }
  };
  const setError = (): void => {
    liveRegion.textContent = strings.runsUnavailable;
    options.telemetry.record("ui.error", { code: "bridge_unavailable" });
    void options.telemetry.flush();
  };
  const getRunDetail = async (runId: string): Promise<RunConsoleDetail> => {
    const response = await options.bridge.callTool(detailTool, { runId });
    return RunConsoleDetailSchema.parse(resultValue(response));
  };
  const openApproval = async (run: RunConsoleRun): Promise<void> => {
    try {
      const detail = await getRunDetail(run.runId);
      const approval = detail.pendingApprovals[0];
      if (approval === undefined) {
        liveRegion.textContent = strings.runsUpdated;
        return;
      }
      await options.bridge.openApproval(approval.approvalId);
    } catch {
      setError();
    }
  };
  const showDetails = async (run: RunConsoleRun): Promise<void> => {
    recordInteraction();
    try {
      const detail = await getRunDetail(run.runId);
      renderDetail(detailHost, detail, strings, document.documentElement.lang, (approvalId) => {
        recordInteraction();
        void options.bridge.openApproval(approvalId).catch(setError);
      });
    } catch {
      detailHost.replaceChildren(createEmptyState(document, strings.errorTitle, strings.runsUnavailable));
      setError();
    }
  };

  async function refresh(): Promise<void> {
    if (disposed || refreshing || document.visibilityState === "hidden") {
      return;
    }
    refreshing = true;
    clearTimer();
    try {
      const status = filter.value === "all" ? undefined : filter.value;
      const response = await options.bridge.callTool(listTool, {
        ...(status === undefined ? {} : { status }),
      });
      const parsed = RunConsoleListSchema.parse(resultValue(response));
      renderRuns(
        listHost,
        parsed.runs,
        now(),
        document.documentElement.lang,
        strings,
        (run) => {
          void showDetails(run);
        },
        (run) => {
          recordInteraction();
          void openApproval(run);
        },
      );
      liveRegion.textContent = strings.runsUpdated;
      if (!hasRendered) {
        options.telemetry.record("ui.render", {});
        hasRendered = true;
      }
      pollDelay = pollIntervalMs;
    } catch {
      setError();
      pollDelay = Math.min(pollDelay * 2, maxPollIntervalMs);
    } finally {
      refreshing = false;
      schedule(pollDelay);
    }
  }

  const refreshNow = (): void => {
    recordInteraction();
    void refresh();
  };
  const filterChanged = (): void => {
    recordInteraction();
    void refresh();
  };
  const visibilityChanged = (): void => {
    if (document.visibilityState === "hidden") {
      clearTimer();
    } else {
      void refresh();
    }
  };
  refreshButton.addEventListener("click", refreshNow);
  filter.addEventListener("change", filterChanged);
  document.addEventListener("visibilitychange", visibilityChanged);
  void refresh();

  return {
    refresh,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimer();
      refreshButton.removeEventListener("click", refreshNow);
      filter.removeEventListener("change", filterChanged);
      document.removeEventListener("visibilitychange", visibilityChanged);
      container.replaceChildren();
    },
  };
}
