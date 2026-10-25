// SPDX-License-Identifier: Apache-2.0
import type { AppTelemetry } from "@rovinos/app-telemetry";
import {
  RunConsoleDetailSchema,
  RunConsoleListSchema,
  type RunConsoleDetail,
  type RunConsoleRun,
} from "@rovinos/schemas/browser";
import { createEmptyState } from "../../kit/components.js";
import { getStrings } from "../../kit/strings.js";
import { nextVisibleRunPage, runsConsolePageSize, runsConsoleResultValue } from "./list.js";
import {
  createRunsConsoleLayout,
  renderRunDetail,
  renderRuns,
  type RunsConsoleLayout,
} from "./render.js";

const listTool = "harness.runs.list";
const detailTool = "harness.runs.get";
const pollIntervalMs = 5_000;
const maxPollIntervalMs = 60_000;
const maxTelemetryActivationWaitMs = 2_500;
const telemetryActivationPollMs = 25;

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
  /** Registers an optional run-resource listener and reports when it is lost. */
  subscribeRuns?(onUpdate: () => void, onError: () => void): () => void;
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

class RunsConsoleController implements RunsConsoleView {
  private readonly document: Document;
  private readonly window: Window;
  private readonly strings: ReturnType<typeof getStrings>;
  private readonly layout: RunsConsoleLayout;
  private readonly now: () => number;
  private timer: number | undefined;
  private unsubscribeRuns: (() => void) | undefined;
  private pollDelay = pollIntervalMs;
  private refreshing = false;
  private refreshRequested = false;
  private detailGeneration = 0;
  private requestedFilter: string | undefined;
  private nextCursor: string | undefined;
  private runs: RunConsoleRun[] = [];
  private telemetryActivationTimer: number | undefined;
  private telemetryActivationTimeout: number | undefined;
  private disposed = false;
  private hasRendered = false;
  private pendingRenderSpan = false;
  private clickCount = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: RunsConsoleOptions,
    window: Window,
  ) {
    this.document = container.ownerDocument;
    this.window = window;
    this.strings = getStrings(this.document.documentElement.lang);
    this.layout = createRunsConsoleLayout(container, this.strings);
    this.now = options.now ?? (() => Date.now());
    this.layout.refreshButton.addEventListener("click", this.refreshClicked);
    this.layout.loadMoreButton.addEventListener("click", this.loadMoreClicked);
    this.layout.filter.addEventListener("change", this.filterChanged);
    this.document.addEventListener("visibilitychange", this.visibilityChanged);
    const subscriptionState = { ready: false, failed: false };
    try {
      this.unsubscribeRuns = options.bridge.subscribeRuns?.(
        () => {
          void this.refresh();
        },
        () => {
          if (subscriptionState.ready) {
            this.subscriptionFailed();
          } else {
            subscriptionState.failed = true;
          }
        },
      );
      subscriptionState.ready = true;
      if (subscriptionState.failed) {
        this.subscriptionFailed();
      }
    } catch {
      this.unsubscribeRuns = undefined;
    }
    void this.refresh();
  }

  private readonly refreshClicked = (): void => {
    this.recordInteraction();
    void this.refresh();
  };

  private readonly filterChanged = (): void => {
    this.recordInteraction();
    this.requestedFilter = this.currentFilter();
    this.nextCursor = undefined;
    this.runs = [];
    this.layout.listHost.replaceChildren();
    this.layout.liveRegion.textContent = this.strings.runsLoading;
    void this.refresh();
  };

  private readonly loadMoreClicked = (): void => {
    this.recordInteraction();
    void this.loadMore();
  };

  private readonly visibilityChanged = (): void => {
    if (this.document.visibilityState === "hidden") {
      this.clearTimer();
      this.flushInteractions();
    } else {
      void this.refresh();
    }
  };

  private recordInteraction(): void {
    this.clickCount = Math.min(1000, this.clickCount + 1);
  }

  private flushInteractions(): void {
    if (this.clickCount > 0) {
      this.options.telemetry.record("ui.interaction", {
        kind: "click",
        count: this.clickCount,
      });
      this.clickCount = 0;
    }
    void this.options.telemetry.flush();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.window.clearTimeout(this.timer);
      this.timer = undefined;
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

  private currentFilter(): string | undefined {
    return this.layout.filter.value === "all" ? undefined : this.layout.filter.value;
  }

  private currentFilterMatches(requested: string | undefined): boolean {
    return requested === this.currentFilter();
  }

  private clearTelemetryActivationTimers(): void {
    if (this.telemetryActivationTimer !== undefined) {
      this.window.clearInterval(this.telemetryActivationTimer);
      this.telemetryActivationTimer = undefined;
    }
    if (this.telemetryActivationTimeout !== undefined) {
      this.window.clearTimeout(this.telemetryActivationTimeout);
      this.telemetryActivationTimeout = undefined;
    }
  }

  private flushRenderSpan(): void {
    if (!this.pendingRenderSpan || !this.options.telemetry.active) {
      return;
    }
    this.clearTelemetryActivationTimers();
    this.pendingRenderSpan = false;
    this.options.telemetry.record("ui.render", {});
    void this.options.telemetry.flush();
  }

  private waitForTelemetryActivation(): void {
    if (this.telemetryActivationTimer !== undefined || !this.pendingRenderSpan) {
      return;
    }
    this.telemetryActivationTimer = this.window.setInterval(() => {
      this.flushRenderSpan();
    }, telemetryActivationPollMs);
    this.telemetryActivationTimeout = this.window.setTimeout(() => {
      this.clearTelemetryActivationTimers();
    }, maxTelemetryActivationWaitMs);
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

  private setError(): void {
    this.layout.liveRegion.textContent = this.strings.runsUnavailable;
    this.options.telemetry.record("ui.error", { code: "bridge_unavailable" });
    void this.options.telemetry.flush();
  }

  private async getRunDetail(runId: string): Promise<RunConsoleDetail> {
    const response = await this.options.bridge.callTool(detailTool, { runId });
    return RunConsoleDetailSchema.parse(runsConsoleResultValue(response));
  }

  private async openApproval(run: RunConsoleRun): Promise<void> {
    try {
      const detail = await this.getRunDetail(run.runId);
      const approval = detail.pendingApprovals[0];
      if (approval === undefined) {
        this.layout.liveRegion.textContent = this.strings.runsUpdated;
        return;
      }
      await this.options.bridge.openApproval(approval.approvalId);
    } catch {
      this.setError();
    }
  }

  private async showDetails(run: RunConsoleRun): Promise<void> {
    this.recordInteraction();
    const generation = ++this.detailGeneration;
    try {
      const detail = await this.getRunDetail(run.runId);
      if (generation !== this.detailGeneration || this.disposed) {
        return;
      }
      renderRunDetail(this.layout.detailHost, detail, {
        strings: this.strings,
        locale: this.document.documentElement.lang,
        onOpenApproval: (approvalId) => {
          this.recordInteraction();
          void this.options.bridge.openApproval(approvalId).catch(() => {
            this.setError();
          });
        },
      });
    } catch {
      if (generation !== this.detailGeneration || this.disposed) {
        return;
      }
      this.layout.detailHost.replaceChildren(
        createEmptyState(this.document, this.strings.errorTitle, this.strings.runsUnavailable),
      );
      this.setError();
    }
  }

  private renderList(runs: readonly RunConsoleRun[]): void {
    renderRuns(this.layout.listHost, runs, {
      now: this.now(),
      locale: this.document.documentElement.lang,
      strings: this.strings,
      onDetails: (run) => {
        void this.showDetails(run);
      },
      onApproval: (run) => {
        this.recordInteraction();
        void this.openApproval(run);
      },
    });
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.document.visibilityState === "hidden") {
      return;
    }
    if (this.refreshing) {
      this.refreshRequested = true;
      return;
    }
    this.refreshing = true;
    this.clearTimer();
    const requestedFilter = this.currentFilter();
    try {
      const response = await this.options.bridge.callTool(listTool, {
        limit: runsConsolePageSize,
        ...(requestedFilter === undefined ? {} : { status: requestedFilter }),
      });
      const parsed = RunConsoleListSchema.parse(runsConsoleResultValue(response));
      if (!this.currentFilterMatches(requestedFilter)) {
        this.refreshRequested = true;
        return;
      }
      this.runs = [...parsed.runs];
      this.nextCursor = parsed.nextCursor;
      this.renderList(this.runs);
      this.updateLoadMoreButton();
      this.layout.liveRegion.textContent = this.strings.runsUpdated;
      if (!this.hasRendered) {
        this.hasRendered = true;
        this.pendingRenderSpan = true;
        this.flushRenderSpan();
        this.waitForTelemetryActivation();
      }
      this.pollDelay = pollIntervalMs;
    } catch {
      if (this.currentFilterMatches(requestedFilter)) {
        this.setError();
        this.pollDelay = Math.min(this.pollDelay * 2, maxPollIntervalMs);
      } else {
        this.refreshRequested = true;
      }
    } finally {
      this.refreshing = false;
      if (this.refreshRequested || !this.currentFilterMatches(requestedFilter)) {
        this.refreshRequested = false;
        void this.refresh();
      } else {
        if (this.unsubscribeRuns === undefined) {
          this.schedule(this.pollDelay);
        }
      }
    }
  }

  private updateLoadMoreButton(): void {
    this.layout.loadMoreButton.hidden = this.nextCursor === undefined;
  }

  private async loadMore(): Promise<void> {
    if (this.disposed || this.nextCursor === undefined || this.refreshing) {
      return;
    }
    this.clearTimer();
    this.refreshing = true;
    const requestedFilter = this.currentFilter();
    const cursor = this.nextCursor;
    try {
      const page = await nextVisibleRunPage(this.options.bridge, requestedFilter, cursor, () =>
        this.currentFilterMatches(requestedFilter),
      );
      if (page === undefined && !this.currentFilterMatches(requestedFilter)) {
        this.refreshRequested = true;
      }
      if (page !== undefined && this.currentFilterMatches(requestedFilter)) {
        this.runs = [...this.runs, ...page.runs];
        this.nextCursor = page.nextCursor;
        this.renderList(this.runs);
        this.updateLoadMoreButton();
        this.layout.liveRegion.textContent = this.strings.runsUpdated;
      }
    } catch {
      if (this.currentFilterMatches(requestedFilter)) {
        this.setError();
      }
    } finally {
      this.refreshing = false;
      if (this.unsubscribeRuns === undefined) {
        this.schedule(this.pollDelay);
      }
      if (this.refreshRequested) {
        this.refreshRequested = false;
        void this.refresh();
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimer();
    this.unsubscribeRuns?.();
    this.unsubscribeRuns = undefined;
    this.clearTelemetryActivationTimers();
    this.detailGeneration += 1;
    this.layout.refreshButton.removeEventListener("click", this.refreshClicked);
    this.layout.loadMoreButton.removeEventListener("click", this.loadMoreClicked);
    this.layout.filter.removeEventListener("change", this.filterChanged);
    this.document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.flushInteractions();
    this.container.replaceChildren();
  }
}

/** Mounts an accessible metadata-only runs console backed by MCP App bridge tools. */
export function createRunsConsoleView(
  container: HTMLElement,
  options: RunsConsoleOptions,
): RunsConsoleView {
  const window = container.ownerDocument.defaultView;
  if (window === null) {
    throw new Error("runs_console_document_unavailable");
  }
  return new RunsConsoleController(container, options, window);
}
