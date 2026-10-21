// SPDX-License-Identifier: Apache-2.0
import type { AppTelemetry } from "@harness/app-telemetry";
import {
  RunConsoleDetailSchema,
  RunConsoleListSchema,
  type RunConsoleDetail,
  type RunConsoleRun,
} from "@harness/schemas/browser";
import { createEmptyState } from "../../kit/components.js";
import { getStrings } from "../../kit/strings.js";
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

function resultValue(result: {
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown;
}): unknown {
  if (result.isError === true || result.structuredContent === undefined) {
    throw new Error("runs_console_tool_failed");
  }
  return result.structuredContent;
}

class RunsConsoleController implements RunsConsoleView {
  private readonly document: Document;
  private readonly window: Window;
  private readonly strings: ReturnType<typeof getStrings>;
  private readonly layout: RunsConsoleLayout;
  private readonly now: () => number;
  private timer: number | undefined;
  private pollDelay = pollIntervalMs;
  private refreshing = false;
  private disposed = false;
  private hasRendered = false;
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
    this.layout.filter.addEventListener("change", this.filterChanged);
    this.document.addEventListener("visibilitychange", this.visibilityChanged);
    void this.refresh();
  }

  private readonly refreshClicked = (): void => {
    this.recordInteraction();
    void this.refresh();
  };

  private readonly filterChanged = (): void => {
    this.recordInteraction();
    void this.refresh();
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
    return RunConsoleDetailSchema.parse(resultValue(response));
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
    try {
      const detail = await this.getRunDetail(run.runId);
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
    if (this.disposed || this.refreshing || this.document.visibilityState === "hidden") {
      return;
    }
    this.refreshing = true;
    this.clearTimer();
    try {
      const status = this.layout.filter.value === "all" ? undefined : this.layout.filter.value;
      const response = await this.options.bridge.callTool(listTool, {
        ...(status === undefined ? {} : { status }),
      });
      const parsed = RunConsoleListSchema.parse(resultValue(response));
      this.renderList(parsed.runs);
      this.layout.liveRegion.textContent = this.strings.runsUpdated;
      if (!this.hasRendered) {
        this.options.telemetry.record("ui.render", {});
        this.hasRendered = true;
      }
      this.pollDelay = pollIntervalMs;
    } catch {
      this.setError();
      this.pollDelay = Math.min(this.pollDelay * 2, maxPollIntervalMs);
    } finally {
      this.refreshing = false;
      this.schedule(this.pollDelay);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimer();
    this.layout.refreshButton.removeEventListener("click", this.refreshClicked);
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
