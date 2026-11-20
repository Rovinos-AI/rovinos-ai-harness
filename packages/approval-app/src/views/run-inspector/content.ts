// SPDX-License-Identifier: Apache-2.0
import { RunContentSchema, type RunContent } from "@rovinos/schemas/browser";
import { getStrings } from "../../kit/strings.js";
import { renderTokenizedContent } from "./view-render.js";

type InspectorStrings = ReturnType<typeof getStrings>;

interface ContentBridge {
  callTool(
    name: "harness.runs.content",
    args: Record<string, unknown>,
  ): Promise<{
    readonly isError?: boolean | undefined;
    readonly structuredContent?: unknown;
  }>;
}

/** Explicitly loads, displays, and clears tokenized event content. */
export class RunInspectorContent {
  private content: RunContent | undefined;
  private visible = false;

  constructor(
    private readonly document: Document,
    private readonly button: HTMLButtonElement,
    private readonly host: HTMLElement,
    private readonly strings: InspectorStrings,
    private readonly bridge: ContentBridge,
    private readonly currentRunId: () => string,
    private readonly isActive: () => boolean,
    private readonly onInteraction: () => void,
  ) {
    this.button.addEventListener("click", this.toggle);
    this.render();
  }

  private readonly toggle = (): void => {
    this.onInteraction();
    if (this.visible) {
      this.visible = false;
      this.render();
    } else if (this.content !== undefined) {
      this.visible = true;
      this.render();
    } else {
      void this.load();
    }
  };

  private async load(): Promise<void> {
    const runId = this.currentRunId();
    try {
      const response = await this.bridge.callTool("harness.runs.content", { runId });
      if (!this.isActive() || runId !== this.currentRunId()) {
        return;
      }
      if (response.isError === true || response.structuredContent === undefined) {
        throw new Error("run_inspector_content_unavailable");
      }
      const content = RunContentSchema.parse(response.structuredContent);
      if (content.runId !== runId) {
        throw new Error("run_inspector_content_run_mismatch");
      }
      this.content = content;
      this.visible = true;
      this.render();
    } catch {
      if (!this.isActive() || runId !== this.currentRunId()) {
        return;
      }
      const message = this.document.createElement("p");
      message.textContent = this.strings.runInspectorContentUnavailable;
      this.host.replaceChildren(message);
      this.host.hidden = false;
    }
  }

  private render(): void {
    renderTokenizedContent(
      this.document,
      this.button,
      this.host,
      this.strings,
      this.visible,
      this.content,
    );
  }

  reset(): void {
    this.content = undefined;
    this.visible = false;
    this.render();
  }

  dispose(): void {
    this.button.removeEventListener("click", this.toggle);
    this.reset();
  }
}
