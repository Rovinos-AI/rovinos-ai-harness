// SPDX-License-Identifier: Apache-2.0
import { RunStatus, type RunConsoleDetail, type RunConsoleRun } from "@harness/schemas/browser";
import { createEmptyState, createStatusBadge } from "../../kit/components.js";
import { formatMessage, formatNumber } from "../../kit/strings.js";
import type { getStrings } from "../../kit/strings.js";

/** DOM elements shared by the runs console controller. */
export interface RunsConsoleLayout {
  readonly filter: HTMLSelectElement;
  readonly refreshButton: HTMLButtonElement;
  readonly liveRegion: HTMLElement;
  readonly listHost: HTMLElement;
  readonly detailHost: HTMLElement;
}

/** Localized values and approval action used to render a run's metadata. */
export interface RenderDetailOptions {
  readonly strings: ReturnType<typeof getStrings>;
  readonly locale: string;
  readonly onOpenApproval: (approvalId: string) => void;
}

/** Localized values and row actions used to render the filtered run list. */
export interface RenderRunsOptions {
  readonly now: number;
  readonly locale: string;
  readonly strings: ReturnType<typeof getStrings>;
  readonly onDetails: (run: RunConsoleRun) => void;
  readonly onApproval: (run: RunConsoleRun) => void;
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
  let amount = seconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  if (seconds >= 86_400) {
    amount = Math.floor(seconds / 86_400);
    unit = "day";
  } else if (seconds >= 3600) {
    amount = Math.floor(seconds / 3600);
    unit = "hour";
  } else if (seconds >= 60) {
    amount = Math.floor(seconds / 60);
    unit = "minute";
  }
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-amount, unit);
  } catch {
    return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-amount, unit);
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

/** Creates the accessible console landmarks and their persistent controls. */
export function createRunsConsoleLayout(
  container: HTMLElement,
  strings: ReturnType<typeof getStrings>,
): RunsConsoleLayout {
  const document = container.ownerDocument;
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
  liveRegion.textContent = strings.runsLoading;
  main.append(liveRegion);
  const listHost = element(document, "section");
  listHost.setAttribute("aria-label", strings.runsConsoleTitle);
  const detailHost = element(document, "section");
  detailHost.setAttribute("aria-live", "polite");
  main.append(listHost, detailHost);
  container.replaceChildren(main);
  heading.focus();
  return { filter, refreshButton, liveRegion, listHost, detailHost };
}

function appendMetadata(
  document: Document,
  parent: HTMLElement,
  label: string,
  value: string,
): void {
  parent.append(element(document, "dt", label), element(document, "dd", value));
}

/** Replaces the detail panel with metadata and available approval actions. */
export function renderRunDetail(
  host: HTMLElement,
  detail: RunConsoleDetail,
  options: RenderDetailOptions,
): void {
  const document = host.ownerDocument;
  const { strings, locale, onOpenApproval } = options;
  const section = element(document, "section");
  section.setAttribute("aria-labelledby", "run-detail-heading");
  const heading = element(document, "h2", strings.runDetailsTitle);
  heading.id = "run-detail-heading";
  section.append(heading);
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
    button.addEventListener("click", () => {
      onOpenApproval(approval.approvalId);
    });
    section.append(button);
  }
  host.replaceChildren(section);
}

function renderRunRow(
  document: Document,
  run: RunConsoleRun,
  options: RenderRunsOptions,
): HTMLTableRowElement {
  const { now, locale, strings, onDetails, onApproval } = options;
  const row = element(document, "tr");
  const runIdCell = element(document, "th", run.runId);
  const statusCell = element(document, "td");
  const ageCell = element(document, "td", relativeAge(run.createdAt, now, locale));
  const stepsCell = element(document, "td", formatNumber(run.steps, locale));
  const approvalCell = element(document, "td");
  const detailsCell = element(document, "td");
  row.append(runIdCell, statusCell, ageCell, stepsCell, approvalCell, detailsCell);
  runIdCell.scope = "row";
  statusCell.append(createStatusBadge(document, statusKind(run.status), run.status));
  if (run.pendingApprovals > 0) {
    const approvalButton = element(
      document,
      "button",
      formatMessage(strings.needsApproval, { count: run.pendingApprovals }, locale),
    );
    approvalButton.type = "button";
    approvalButton.addEventListener("click", () => {
      onApproval(run);
    });
    approvalCell.append(approvalButton);
  } else {
    approvalCell.textContent = formatNumber(0, locale);
  }
  const detailsButton = element(document, "button", strings.viewRunDetails);
  detailsButton.type = "button";
  detailsButton.addEventListener("click", () => {
    onDetails(run);
  });
  detailsCell.append(detailsButton);
  return row;
}

/** Renders the table or its empty state using only DOM text nodes. */
export function renderRuns(
  host: HTMLElement,
  runs: readonly RunConsoleRun[],
  options: RenderRunsOptions,
): void {
  const document = host.ownerDocument;
  const { strings } = options;
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
    body.append(renderRunRow(document, run, options));
  }
  table.append(head, body);
  wrapper.append(table);
  host.replaceChildren(wrapper);
}
