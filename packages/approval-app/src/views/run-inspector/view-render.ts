// SPDX-License-Identifier: Apache-2.0
import type { RunContent, RunTimeline, RunTimelineStep } from "@rovinos/schemas/browser";
import { createMeter, createStatusBadge } from "../../kit/components.js";
import { formatMessage, formatNumber, getStrings } from "../../kit/strings.js";

type InspectorStrings = ReturnType<typeof getStrings>;

interface TimelineActions {
  readonly onSelect: (step: RunTimelineStep) => void;
  readonly onApproval: (approvalId: string) => void;
  readonly onInput: (requestId: string) => void;
  readonly onSubagent: (step: RunTimelineStep) => void;
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

function statusKind(
  status: RunTimeline["status"],
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

function renderUsage(
  document: Document,
  host: HTMLElement,
  strings: InspectorStrings,
  timeline: RunTimeline,
): void {
  const usage = element(document, "dl");
  const addUsage = (label: string, value: string): void => {
    usage.append(element(document, "dt", label), element(document, "dd", value));
  };
  const totalCost =
    timeline.usage.cost.knownMicros +
    timeline.usage.cost.estimatedMicros +
    timeline.usage.cost.partialMicros;
  addUsage(strings.runDetailStatus, timeline.status);
  addUsage(strings.runDetailSteps, formatNumber(timeline.usage.steps, document.documentElement.lang));
  addUsage(
    strings.runDetailInputTokens,
    formatNumber(timeline.usage.inputTokens, document.documentElement.lang),
  );
  addUsage(
    strings.runDetailOutputTokens,
    formatNumber(timeline.usage.outputTokens, document.documentElement.lang),
  );
  addUsage(strings.runDetailCost, formatNumber(totalCost, document.documentElement.lang));
  host.replaceChildren(createStatusBadge(document, statusKind(timeline.status), timeline.status), usage);
}

function pendingActionButton(
  document: Document,
  strings: InspectorStrings,
  step: RunTimelineStep,
  actions: TimelineActions,
): HTMLButtonElement | undefined {
  if (step.type === "approval_wait" && step.status === "pending" && step.approvalId !== undefined) {
    const approvalId = step.approvalId;
    const button = element(
      document,
      "button",
      formatMessage(strings.runInspectorOpenApproval, { id: approvalId }),
    );
    button.type = "button";
    button.addEventListener("click", () => actions.onApproval(approvalId));
    return button;
  }
  if (step.type === "input_wait" && step.status === "pending" && step.requestId !== undefined) {
    const requestId = step.requestId;
    const button = element(
      document,
      "button",
      formatMessage(strings.runInspectorOpenInput, { id: requestId }),
    );
    button.type = "button";
    button.addEventListener("click", () => actions.onInput(requestId));
    return button;
  }
  return undefined;
}

function timelineStepItem(
  document: Document,
  strings: InspectorStrings,
  step: RunTimelineStep,
  selectedStep: RunTimelineStep | undefined,
  actions: TimelineActions,
): HTMLLIElement {
  const item = element(document, "li");
  const select = element(
    document,
    "button",
    `${step.type.replaceAll("_", " ")} · ${step.status ?? "unknown"}`,
  );
  select.type = "button";
  select.setAttribute("aria-pressed", String(selectedStep?.seq === step.seq));
  select.addEventListener("click", () => actions.onSelect(step));
  item.append(select);
  const action = pendingActionButton(document, strings, step, actions);
  if (action !== undefined) {
    item.append(action);
  }
  if (step.type === "subagent_spawn" && step.childRunId !== undefined) {
    const child = element(
      document,
      "button",
      formatMessage(strings.runInspectorOpenSubagent, { id: step.childRunId }),
    );
    child.type = "button";
    child.addEventListener("click", () => actions.onSubagent(step));
    item.append(child);
  }
  return item;
}

function renderTimeline(
  document: Document,
  host: HTMLElement,
  strings: InspectorStrings,
  timeline: RunTimeline,
  selectedStep: RunTimelineStep | undefined,
  actions: TimelineActions,
): void {
  const list = element(document, "ol");
  list.className = "timeline";
  list.setAttribute("aria-label", strings.runInspectorTimeline);
  for (const step of timeline.steps) {
    list.append(timelineStepItem(document, strings, step, selectedStep, actions));
  }
  host.replaceChildren(list);
}

function renderSelectedStep(
  document: Document,
  host: HTMLElement,
  strings: InspectorStrings,
  step: RunTimelineStep | undefined,
): void {
  if (step === undefined) {
    return;
  }
  const panel = element(document, "section");
  panel.setAttribute("aria-labelledby", "run-inspector-selected-heading");
  const heading = element(document, "h3", strings.runInspectorSelectedStep);
  heading.id = "run-inspector-selected-heading";
  const metadata = element(document, "dl");
  const values: readonly [string, string | number | undefined][] = [
    ["Type", step.type],
    ["Status", step.status],
    ["Policy", step.policyDecision],
    ["Outcome", step.outcome],
    ["Duration (ms)", step.durationMs],
    ["Input tokens", step.inputTokens],
    ["Output tokens", step.outputTokens],
    ["Provider", step.provider],
    ["Model", step.model],
    ["Tool", step.toolId],
    ["Role", step.role],
    ["Max steps", step.maxSteps],
    ["Max cost (USD)", step.maxCostUsd],
    ["Max wall clock (ms)", step.maxWallClockMs],
    ["Budget deadline", step.budgetDeadlineTs],
  ];
  for (const [label, value] of values) {
    if (value !== undefined) {
      metadata.append(element(document, "dt", label), element(document, "dd", String(value)));
    }
  }
  panel.append(heading, metadata);
  host.append(panel);
}

function exceededBudgetMeter(
  document: Document,
  strings: InspectorStrings,
  section: HTMLElement,
  step: RunTimelineStep,
): void {
  if (step.type !== "budget_exceeded" || step.budget === undefined) {
    return;
  }
  const limit = step.limit ?? 1;
  const observed = step.observed ?? limit;
  const label = formatMessage(strings.runInspectorBudgetExceeded, { budget: step.budget });
  section.append(createMeter(document, label, observed, Math.max(limit, observed)));
}

function completedChildMeters(
  document: Document,
  strings: InspectorStrings,
  section: HTMLElement,
  child: RunTimelineStep,
  completion: RunTimelineStep | undefined,
): void {
  if (completion === undefined || child.childRunId === undefined) {
    return;
  }
  const childRunId = child.childRunId;
  const addMeter = (budget: string, value: number | undefined, limit: number | undefined): void => {
    if (value === undefined || limit === undefined) {
      return;
    }
    const label = formatMessage(strings.runInspectorSubagentBudget, {
      id: childRunId,
      budget,
    });
    section.append(createMeter(document, label, value, limit));
  };
  addMeter("steps", completion.stepsUsed, child.maxSteps);
  addMeter(
    "cost",
    completion.costMicros === undefined ? undefined : completion.costMicros / 1_000_000,
    child.maxCostUsd,
  );
  addMeter("wall clock", completion.durationMs, child.maxWallClockMs);
}

function renderBudgetMeters(
  document: Document,
  host: HTMLElement,
  strings: InspectorStrings,
  timeline: RunTimeline,
): void {
  const section = element(document, "div");
  for (const step of timeline.steps) {
    exceededBudgetMeter(document, strings, section, step);
    if (step.type === "subagent_spawn") {
      const completion = timeline.steps.find(
        (candidate) =>
          candidate.type === "subagent_completion" && candidate.childRunId === step.childRunId,
      );
      completedChildMeters(document, strings, section, step, completion);
    }
  }
  if (section.childElementCount > 0) {
    host.append(section);
  }
}

/** Renders the safe usage, timeline, selected-step, and budget projections. */
export function renderInspector(
  document: Document,
  detailHost: HTMLElement,
  timelineHost: HTMLElement,
  strings: InspectorStrings,
  timeline: RunTimeline,
  selectedStep: RunTimelineStep | undefined,
  actions: TimelineActions,
): void {
  detailHost.replaceChildren();
  renderUsage(document, detailHost, strings, timeline);
  renderSelectedStep(document, detailHost, strings, selectedStep);
  renderBudgetMeters(document, detailHost, strings, timeline);
  renderTimeline(document, timelineHost, strings, timeline, selectedStep, actions);
}

/** Renders explicitly requested tokenized event content as inert text. */
export function renderTokenizedContent(
  document: Document,
  button: HTMLButtonElement,
  host: HTMLElement,
  strings: InspectorStrings,
  visible: boolean,
  content: RunContent | undefined,
): void {
  button.textContent = visible ? strings.runInspectorHideContent : strings.runInspectorShowContent;
  if (!visible || content === undefined) {
    host.replaceChildren();
    host.hidden = true;
    return;
  }
  const entries = content.events.map(({ seq, type, value }) => ({ seq, type, value }));
  const nodes: Node[] = [element(document, "pre", JSON.stringify(entries, null, 2))];
  if (content.truncated) {
    nodes.push(element(document, "p", strings.runInspectorTruncated));
  }
  host.replaceChildren(...nodes);
  host.hidden = false;
}
