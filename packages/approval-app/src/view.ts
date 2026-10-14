// SPDX-License-Identifier: Apache-2.0
// Task 5.3 renders only; decision and reveal handlers belong to task 5.4.
import { ApprovalPayloadSchema, type JsonValue } from "@harness/schemas/browser";
import { appendTokenText } from "./tokens.js";

/** Injected view dependencies; errors contain only the closed payload-invalid code. */
export interface ApprovalViewOptions {
  readonly clock: { now(): number };
  readonly onError: (code: "payload_invalid") => void;
}

/** One approval view with an explicit refresh hook for its injected clock. */
export interface ApprovalView {
  receive(input: unknown): void;
  tick(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    appendTokenText(node, text);
  }
  return node;
}

function argumentNode(document: Document, value: JsonValue, label: string): HTMLElement {
  if (typeof value !== "object" || value === null) {
    const leaf = element(document, "div", `${label}: `);
    appendTokenText(leaf, typeof value === "string" ? value : String(value));
    return leaf;
  }
  const branch = element(document, "details");
  branch.open = true;
  branch.append(element(document, "summary", label));
  const children = element(document, "ul");
  for (const [key, child] of Object.entries(value)) {
    const item = element(document, "li");
    item.append(argumentNode(document, child, key));
    children.append(item);
  }
  branch.append(children);
  return branch;
}

function addMetadata(document: Document, row: HTMLElement, label: string, value: string): void {
  row.append(element(document, "dt", label), element(document, "dd", value));
}

/**
 * Mounts the token-only approval screen and validates every delivered payload.
 *
 * @param root - Empty app container.
 * @param options - Injected wall clock and metadata-only error reporter.
 * @returns Payload receiver and countdown refresh hook.
 */
export function createApprovalView(root: HTMLElement, options: ApprovalViewOptions): ApprovalView {
  const document = root.ownerDocument;
  const main = element(document, "main");
  const heading = element(document, "h1", "Waiting for approval");
  heading.tabIndex = -1;
  const status = element(document, "p", "Waiting for host");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = element(document, "div");
  main.append(heading, status, content);
  root.replaceChildren(main);
  heading.focus();
  let refresh = (): void => undefined;

  function receive(input: unknown): void {
    const parsed = ApprovalPayloadSchema.safeParse(input);
    content.replaceChildren();
    refresh = () => undefined;
    if (!parsed.success) {
      heading.textContent = "Approval unavailable";
      status.textContent = "Invalid approval payload";
      options.onError("payload_invalid");
      heading.focus();
      return;
    }
    const payload = parsed.data;
    heading.replaceChildren();
    appendTokenText(heading, payload.summary);
    const metadata = element(document, "dl");
    addMetadata(document, metadata, "Tool", payload.toolId);
    addMetadata(document, metadata, "Rule", payload.ruleId);
    addMetadata(document, metadata, "Reason", payload.reason);
    const expiry = element(document, "dd");
    metadata.append(element(document, "dt", "Expiry"), expiry);
    const args = element(document, "section");
    args.setAttribute("aria-label", "Arguments");
    args.append(
      element(document, "h2", "Arguments"),
      argumentNode(document, payload.args, "Arguments"),
    );
    const actions = element(document, "nav");
    actions.setAttribute("aria-label", "Approval actions");
    const labels =
      payload.editableFields.length > 0 ? ["Approve", "Deny", "Edit"] : ["Approve", "Deny"];
    const buttons = labels.map((label) => element(document, "button", label));
    for (const button of buttons) {
      button.type = "button";
      actions.append(button);
    }
    content.append(metadata, args, actions);
    refresh = () => {
      const remaining =
        payload.expiresAt === undefined ? undefined : payload.expiresAt - options.clock.now();
      const expired = remaining !== undefined && remaining <= 0;
      expiry.textContent =
        remaining === undefined
          ? "No expiry"
          : `${String(Math.max(0, Math.ceil(remaining / 1000)))} seconds remaining`;
      status.textContent = expired ? "Approval expired" : "Pending approval";
      for (const button of buttons) {
        button.disabled = expired;
      }
    };
    refresh();
    heading.focus();
  }

  return {
    receive,
    tick: () => {
      refresh();
    },
  };
}
