// SPDX-License-Identifier: Apache-2.0
import type { AppTelemetry } from "@rovinos/app-telemetry";
import {
  RunInspectorRunIdSchema,
  RunTimelineSchema,
  type RunTimeline,
  type RunTimelineStep,
} from "@rovinos/schemas/browser";
import { getStrings } from "../../kit/strings.js";
import { RunInspectorContent } from "./content.js";
import { renderInspector } from "./view-render.js";

const detailTool = "get_run";
const timelineTool = "get_run_timeline";
const contentTool = "harness.runs.content";
const pollIntervalMs = 5_000;
const maxPollIntervalMs = 60_000;

type InspectorTelemetry = AppTelemetry<readonly ["ui.render", "ui.error", "ui.interaction"]>;

/** Minimal app bridge surface used by the run inspector. */
export interface RunInspectorBridge {
  callTool(
    name: typeof detailTool | typeof timelineTool | typeof contentTool,
    args: Record<string, unknown>,
  ): Promise<{
    readonly isError?: boolean | undefined;
    readonly structuredContent?: unknown;
  }>;
  /** Registers an optional app-host run update listener. */
  readonly subscribeRuns?: (onUpdate: () => void, onError: () => void) => () => void;
  openApproval(approvalId: string): Promise<void>;
  openInput(requestId: string): Promise<void>;
}

/** Options for mounting a run inspector view. */
export interface RunInspectorOptions {
  readonly bridge: RunInspectorBridge;
  readonly runId: string;
  readonly telemetry: InspectorTelemetry;
}

/** Mounted run inspector controls and cleanup. */
export interface RunInspectorView {
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

class RunInspectorController implements RunInspectorView {
  private readonly document: Document;
  private readonly window: Window;
  private readonly strings: ReturnType<typeof getStrings>;
  private readonly main: HTMLElement;
  private readonly liveRegion: HTMLElement;
  private readonly pausedIndicator: HTMLElement;
  private readonly timelineHost: HTMLElement;
  private readonly detailHost: HTMLElement;
  private readonly contentButton: HTMLButtonElement;
  private readonly contentHost: HTMLElement;
  private readonly content: RunInspectorContent;
  private readonly backButton: HTMLButtonElement;
  private readonly runIdLabel: HTMLElement;
  private runId: string;
  private readonly runStack: string[] = [];
  private timeline: RunTimeline | undefined;
  private selectedStep: RunTimelineStep | undefined;
  private timer: number | undefined;
  private unsubscribeRuns: (() => void) | undefined;
  private pollDelay = pollIntervalMs;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: RunInspectorOptions,
  ) {
    this.document = container.ownerDocument;
    const window = this.document.defaultView;
    if (window === null) {
      throw new Error("run_inspector_window_unavailable");
    }
    this.window = window;
    this.runId = options.runId;
    this.strings = getStrings(this.document.documentElement.lang);

    this.main = element(this.document, "main");
    const heading = element(this.document, "h1", this.strings.runInspectorTitle);
    heading.tabIndex = -1;
    this.main.append(heading, element(this.document, "p", this.strings.runInspectorDescription));
    this.runIdLabel = element(this.document, "p", this.runId);
    this.main.append(this.runIdLabel);
    this.backButton = element(this.document, "button", this.strings.runInspectorBack);
    this.backButton.type = "button";
    this.backButton.hidden = true;
    this.backButton.addEventListener("click", this.goBack);
    this.main.append(this.backButton);

    this.pausedIndicator = element(this.document, "p", this.strings.runInspectorPaused);
    this.pausedIndicator.setAttribute("role", "status");
    this.pausedIndicator.hidden = true;
    this.main.append(this.pausedIndicator);

    const refresh = element(this.document, "button", this.strings.runInspectorRefresh);
    refresh.type = "button";
    refresh.addEventListener("click", () => {
      this.recordInteraction();
      void this.refresh();
    });
    this.main.append(refresh);
    this.liveRegion = element(this.document, "p", this.strings.runInspectorLoading);
    this.liveRegion.setAttribute("role", "status");
    this.liveRegion.setAttribute("aria-live", "polite");
    this.main.append(this.liveRegion);

    const usageSection = element(this.document, "section");
    usageSection.setAttribute("aria-labelledby", "run-inspector-usage-heading");
    const usageHeading = element(this.document, "h2", this.strings.runInspectorUsage);
    usageHeading.id = "run-inspector-usage-heading";
    this.detailHost = element(this.document, "div");
    usageSection.append(usageHeading, this.detailHost);

    const timelineSection = element(this.document, "section");
    timelineSection.setAttribute("aria-labelledby", "run-inspector-timeline-heading");
    const timelineHeading = element(this.document, "h2", this.strings.runInspectorTimeline);
    timelineHeading.id = "run-inspector-timeline-heading";
    this.timelineHost = element(this.document, "div");
    timelineSection.append(timelineHeading, this.timelineHost);
    this.main.append(usageSection, timelineSection);

    this.contentButton = element(this.document, "button", this.strings.runInspectorShowContent);
    this.contentButton.type = "button";
    this.contentHost = element(this.document, "section");
    this.contentHost.setAttribute("aria-label", this.strings.runInspectorShowContent);
    this.contentHost.hidden = true;
    this.content = new RunInspectorContent({
      document: this.document,
      button: this.contentButton,
      host: this.contentHost,
      strings: this.strings,
      bridge: this.options.bridge,
      currentRunId: () => this.runId,
      isActive: () => !this.disposed,
      onInteraction: () => {
        this.recordInteraction();
      },
    });
    this.main.append(this.contentButton, this.contentHost);
    container.replaceChildren(this.main);
    heading.focus();

    this.document.addEventListener("visibilitychange", this.visibilityChanged);
    this.subscribe();
    void this.refresh();
  }

  private recordInteraction(): void {
    this.options.telemetry.record("ui.interaction", { kind: "click", count: 1 });
    void this.options.telemetry.flush();
  }

  private subscribe(): void {
    const subscribeRuns = this.options.bridge.subscribeRuns;
    if (subscribeRuns === undefined) {
      this.schedule(this.pollDelay);
      return;
    }
    const state = { ready: false, failed: false };
    try {
      this.unsubscribeRuns = subscribeRuns.call(
        this.options.bridge,
        () => {
          void this.refresh();
        },
        () => {
          if (state.ready) {
            this.subscriptionFailed();
          } else {
            state.failed = true;
          }
        },
      );
      state.ready = true;
      if (state.failed) {
        this.subscriptionFailed();
      }
    } catch {
      this.unsubscribeRuns = undefined;
      this.schedule(this.pollDelay);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(delay: number): void {
    this.clearTimer();
    if (!this.disposed && this.document.visibilityState !== "hidden") {
      this.timer = this.window.setTimeout(() => {
        this.timer = undefined;
        void this.refresh();
      }, delay);
    }
  }

  private subscriptionFailed(): void {
    const unsubscribe = this.unsubscribeRuns;
    this.unsubscribeRuns = undefined;
    try {
      unsubscribe?.();
    } catch {
      this.schedule(this.pollDelay);
      return;
    }
    this.schedule(this.pollDelay);
  }

  private readonly visibilityChanged = (): void => {
    const hidden = this.document.visibilityState === "hidden";
    this.pausedIndicator.hidden = !hidden;
    if (hidden) {
      this.clearTimer();
    } else {
      void this.refresh();
    }
  };

  private async loadRun(runId: string): Promise<void> {
    const [detailResponse, timelineResponse] = await Promise.all([
      this.options.bridge.callTool(detailTool, { runId }),
      this.options.bridge.callTool(timelineTool, { runId }),
    ]);
    if (
      detailResponse.isError === true ||
      detailResponse.structuredContent === undefined ||
      timelineResponse.isError === true ||
      timelineResponse.structuredContent === undefined
    ) {
      throw new Error("run_inspector_unavailable");
    }
    const detail = RunInspectorRunIdSchema.parse(detailResponse.structuredContent);
    const timeline = RunTimelineSchema.parse(timelineResponse.structuredContent);
    if (detail.runId !== runId || timeline.runId !== runId) {
      throw new Error("run_inspector_run_mismatch");
    }
    this.timeline = timeline;
    this.selectedStep =
      timeline.steps.find(({ seq }) => seq === this.selectedStep?.seq) ?? timeline.steps.at(-1);
    this.render();
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.document.visibilityState === "hidden") {
      return;
    }
    const generation = ++this.generation;
    try {
      await this.loadRun(this.runId);
      if (generation !== this.generation) {
        return;
      }
      this.liveRegion.textContent = this.strings.runInspectorUpdated;
      this.pollDelay = pollIntervalMs;
      if (this.unsubscribeRuns === undefined) {
        this.schedule(this.pollDelay);
      }
    } catch {
      if (generation !== this.generation) {
        return;
      }
      this.liveRegion.textContent = this.strings.runInspectorUnavailable;
      this.options.telemetry.record("ui.error", { code: "bridge_unavailable" });
      void this.options.telemetry.flush();
      if (this.unsubscribeRuns === undefined) {
        this.pollDelay = Math.min(this.pollDelay * 2, maxPollIntervalMs);
        this.schedule(this.pollDelay);
      }
    }
  }

  private render(): void {
    const timeline = this.timeline;
    if (timeline === undefined) {
      return;
    }
    this.runIdLabel.textContent = timeline.runId;
    this.backButton.hidden = this.runStack.length === 0;
    renderInspector({
      document: this.document,
      detailHost: this.detailHost,
      timelineHost: this.timelineHost,
      strings: this.strings,
      timeline,
      selectedStep: this.selectedStep,
      actions: {
        onSelect: (step) => {
          this.recordInteraction();
          this.selectedStep = step;
          this.render();
        },
        onApproval: (approvalId) => {
          void this.options.bridge.openApproval(approvalId);
        },
        onInput: (requestId) => {
          void this.options.bridge.openInput(requestId);
        },
        onSubagent: (step) => {
          this.openSubagent(step);
        },
      },
    });
  }

  private openSubagent(step: RunTimelineStep): void {
    if (step.childRunId === undefined) {
      return;
    }
    this.recordInteraction();
    this.runStack.push(this.runId);
    this.runId = step.childRunId;
    this.timeline = undefined;
    this.selectedStep = undefined;
    this.content.reset();
    this.liveRegion.textContent = this.strings.runInspectorLoading;
    void this.refresh();
  }

  private readonly goBack = (): void => {
    const parentRunId = this.runStack.pop();
    if (parentRunId === undefined) {
      return;
    }
    this.recordInteraction();
    this.runId = parentRunId;
    this.timeline = undefined;
    this.selectedStep = undefined;
    this.content.reset();
    this.liveRegion.textContent = this.strings.runInspectorLoading;
    void this.refresh();
  };

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearTimer();
    this.document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.unsubscribeRuns?.();
    this.unsubscribeRuns = undefined;
    this.content.dispose();
    this.options.telemetry.record("ui.render", {});
    void this.options.telemetry.flush();
  }
}

/** Creates the accessible, live run inspector view. */
export function createRunInspectorView(
  container: HTMLElement,
  options: RunInspectorOptions,
): RunInspectorView {
  return new RunInspectorController(container, options);
}
