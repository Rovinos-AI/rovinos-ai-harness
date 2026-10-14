// SPDX-License-Identifier: Apache-2.0
import {
  parseTokenType,
  ResolveRequest,
  ResolveResponse,
  RevealRequest,
  RevealResponse,
  type ApprovalPayload,
} from "@harness/schemas/browser";
import type { AppTelemetry } from "@harness/app-telemetry";
import { createEditForm } from "./edit-form.js";

type ApprovalDecision = "approve" | "deny" | "edit";
type AppTelemetryForActions = Pick<
  AppTelemetry<readonly ["ui.decision", "ui.error"]>,
  "record" | "flush"
>;

/** The host bridge methods used by the approval decision and reveal controls. */
export interface ApprovalActionsBridge {
  readonly callTool: (
    name: "harness.approvals.resolve" | "harness.approvals.reveal",
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** Dependencies injected into the approval actions for host calls and safe telemetry. */
export interface ApprovalActionsOptions {
  readonly approvalId: string;
  readonly payload: ApprovalPayload;
  readonly isExpired: () => boolean;
  readonly bridge: ApprovalActionsBridge;
  readonly telemetry: AppTelemetryForActions;
  readonly renderRevealed: (values: ReadonlyMap<string, string>) => void;
}

/** Mounted action controls and a non-sensitive state hook for expiry tests. */
export interface ApprovalActions {
  dispose(): void;
  revealedValueCount(): number;
}

interface ActionControls {
  readonly status: HTMLElement;
  readonly reveal: HTMLButtonElement;
  readonly pointers: readonly string[];
  readonly confirm: HTMLElement;
  readonly confirmButton: HTMLButtonElement;
  readonly cancelButton: HTMLButtonElement;
}

interface ActionContext extends ActionControls {
  readonly actions: HTMLElement;
  readonly editHost: HTMLElement;
  readonly document: Document;
  readonly window: Window | null;
  readonly listeners: AbortController;
  readonly options: ApprovalActionsOptions;
  readonly state: {
    busy: boolean;
    disposed: boolean;
    revealedValues: Map<string, string>;
    maskTimer: number | undefined;
    editForm: HTMLFormElement | undefined;
  };
}

type UiErrorCode = "resolve_failed" | "reveal_failed";

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

function pointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectTokenPointers(value: unknown, pointer = ""): string[] {
  if (typeof value === "string") {
    const tokens = value.match(/<[A-Z][A-Z0-9_]*>/gu) ?? [];
    return tokens.some((token) => parseTokenType(token) !== undefined) ? [pointer] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      collectTokenPointers(child, `${pointer}/${String(index)}`),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      collectTokenPointers(child, `${pointer}/${pointerSegment(key)}`),
    );
  }
  return [];
}

const errorMessages: Readonly<Record<string, string>> = {
  approval_not_found: "This approval could not be found.",
  approval_already_resolved: "This approval has already been resolved.",
  approval_run_not_suspended: "This run is no longer awaiting approval.",
  approval_resolution_conflict: "The approval could not be resolved. Try again.",
  edit_invalid: "The edited values are invalid.",
  edit_not_allowed: "One or more edited fields are not allowed.",
  reveal_disabled: "Revealing values is unavailable.",
  reveal_forbidden: "You are not authorized to reveal these values.",
};

function errorMessage(code: string | undefined, decision: "resolve" | "reveal"): string {
  const mapped = code === undefined ? undefined : errorMessages[code];
  if (mapped !== undefined) {
    return mapped;
  }
  return decision === "resolve"
    ? "The approval could not be resolved."
    : "The values could not be revealed.";
}

function button(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  signal: AbortSignal,
): HTMLButtonElement | undefined {
  const control = [...parent.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (control === undefined) {
    return undefined;
  }
  control.addEventListener("click", onClick, { signal });
  return control;
}

function createActionControls(
  actions: HTMLElement,
  editHost: HTMLElement,
  document: Document,
  pointers: readonly string[],
): ActionControls {
  const status = element(document, "p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  actions.after(status);
  const reveal = element(document, "button", "Reveal values");
  reveal.type = "button";
  reveal.disabled = pointers.length === 0;
  actions.append(reveal);
  const confirm = element(document, "section");
  confirm.setAttribute("role", "alertdialog");
  confirm.setAttribute("aria-modal", "true");
  confirm.setAttribute("aria-labelledby", "approval-reveal-confirmation");
  confirm.hidden = true;
  const text = element(
    document,
    "p",
    `Show raw values for ${String(pointers.length)} fields? This is logged.`,
  );
  text.id = "approval-reveal-confirmation";
  const confirmButton = element(document, "button", "Show raw values");
  confirmButton.type = "button";
  const cancelButton = element(document, "button", "Cancel");
  cancelButton.type = "button";
  confirm.append(text, confirmButton, cancelButton);
  editHost.append(confirm);
  return { status, reveal, pointers, confirm, confirmButton, cancelButton };
}

function setBusy(context: ActionContext, busy: boolean): void {
  const state = context.state;
  state.busy = busy;
  const expired = context.options.isExpired();
  for (const control of context.actions.querySelectorAll("button")) {
    control.disabled =
      busy || expired || (control === context.reveal && context.pointers.length === 0);
  }
  for (const control of context.editHost.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
  >("button, input, textarea")) {
    control.disabled = busy || expired;
  }
}

const isExpired = (context: ActionContext): boolean => context.options.isExpired();

const isDisposed = (context: ActionContext): boolean => context.state.disposed;

function reportError(context: ActionContext, code: UiErrorCode, message: string): void {
  const { status } = context;
  status.textContent = message;
  context.options.telemetry.record("ui.error", { code });
  void context.options.telemetry.flush();
}

function decisionStatus(decision: ApprovalDecision): string {
  return {
    approve: "Approval granted.",
    deny: "Approval denied.",
    edit: "Edits submitted.",
  }[decision];
}

async function resolveDecision(
  context: ActionContext,
  decision: ApprovalDecision,
  edits?: ResolveRequest["edits"],
): Promise<void> {
  if (context.state.busy || context.state.disposed) {
    return;
  }
  const { status } = context;
  if (isExpired(context)) {
    return;
  }
  const request = ResolveRequest.safeParse({
    approvalId: context.options.approvalId,
    decision,
    ...(edits === undefined ? {} : { edits }),
  });
  if (!request.success) {
    reportError(context, "resolve_failed", "The approval could not be resolved.");
    return;
  }
  setBusy(context, true);
  status.textContent = "Submitting decision.";
  try {
    const response = ResolveResponse.safeParse(
      await context.options.bridge.callTool("harness.approvals.resolve", request.data),
    );
    if (!response.success || !response.data.ok) {
      const code = response.success ? response.data.code : undefined;
      reportError(context, "resolve_failed", errorMessage(code, "resolve"));
      setBusy(context, false);
      return;
    }
    context.options.telemetry.record("ui.decision", { decision });
    void context.options.telemetry.flush();
    status.textContent = decisionStatus(decision);
    context.state.editForm?.remove();
    setBusy(context, true);
  } catch {
    reportError(context, "resolve_failed", errorMessage(undefined, "resolve"));
    setBusy(context, false);
  }
}

async function showReveal(context: ActionContext): Promise<void> {
  const { confirm, status } = context;
  if (context.state.busy || context.state.disposed || context.pointers.length === 0) {
    return;
  }
  if (isExpired(context)) {
    return;
  }
  setBusy(context, true);
  confirm.hidden = true;
  status.textContent = "Revealing values.";
  try {
    const request = RevealRequest.safeParse({
      approvalId: context.options.approvalId,
      pointers: context.pointers,
    });
    if (!request.success) {
      reportError(context, "reveal_failed", "The values could not be revealed.");
      return;
    }
    const response = RevealResponse.safeParse(
      await context.options.bridge.callTool("harness.approvals.reveal", request.data),
    );
    if (!response.success) {
      reportError(context, "reveal_failed", errorMessage(undefined, "reveal"));
      return;
    }
    if (isDisposed(context)) {
      return;
    }
    const state = context.state;
    const permitted = new Set(context.pointers);
    state.revealedValues = new Map(
      response.data.values
        .filter((item) => permitted.has(item.pointer))
        .map(({ pointer, value }) => [pointer, value]),
    );
    context.options.renderRevealed(state.revealedValues);
    status.textContent = "Values revealed for 30 seconds.";
    if (state.maskTimer !== undefined) {
      context.window?.clearTimeout(state.maskTimer);
    }
    state.maskTimer = context.window?.setTimeout(() => {
      state.revealedValues.clear();
      state.revealedValues = new Map();
      context.options.renderRevealed(state.revealedValues);
      status.textContent = "Sensitive values hidden.";
      state.maskTimer = undefined;
    }, 30_000);
  } catch {
    reportError(context, "reveal_failed", errorMessage(undefined, "reveal"));
  } finally {
    setBusy(context, false);
  }
}

function openEditForm(context: ActionContext): void {
  const state = context.state;
  const { status } = context;
  if (state.busy || state.disposed || state.editForm?.isConnected === true) {
    return;
  }
  if (isExpired(context)) {
    return;
  }
  state.editForm = createEditForm(context.document, context.options.payload, (edits) => {
    if (edits.length === 0) {
      status.textContent = "No changes to submit.";
      return;
    }
    void resolveDecision(context, "edit", edits);
  });
  context.editHost.append(state.editForm);
  status.textContent = "Editing approval.";
}

function bindActionHandlers(context: ActionContext): void {
  const { confirm } = context;
  button(
    context.actions,
    "Approve",
    () => void resolveDecision(context, "approve"),
    context.listeners.signal,
  );
  button(
    context.actions,
    "Deny",
    () => void resolveDecision(context, "deny"),
    context.listeners.signal,
  );
  button(
    context.actions,
    "Edit",
    () => {
      openEditForm(context);
    },
    context.listeners.signal,
  );
  context.reveal.addEventListener(
    "click",
    () => {
      if (!context.state.busy && !context.state.disposed && context.pointers.length > 0) {
        confirm.hidden = false;
        context.confirmButton.focus();
      }
    },
    { signal: context.listeners.signal },
  );
  context.confirmButton.addEventListener("click", () => void showReveal(context), {
    signal: context.listeners.signal,
  });
  context.cancelButton.addEventListener(
    "click",
    () => {
      confirm.hidden = true;
      context.reveal.focus();
    },
    { signal: context.listeners.signal },
  );
}

function disposeActions(context: ActionContext): void {
  const state = context.state;
  state.disposed = true;
  if (state.maskTimer !== undefined) {
    context.window?.clearTimeout(state.maskTimer);
  }
  state.revealedValues.clear();
  state.revealedValues = new Map();
  context.options.renderRevealed(state.revealedValues);
  state.editForm?.remove();
  context.listeners.abort();
  context.confirm.remove();
  context.status.remove();
  context.reveal.remove();
}

/**
 * Wires the approval view to its host-local decision and reveal tools.
 *
 * @param actions - Existing action navigation rendered by the approval view.
 * @param editHost - Container for the policy-approved edit form.
 * @param options - Approval identity, validated payload, host bridge, and metadata telemetry.
 * @returns Cleanup and an expiry-safe test hook that exposes only a value count.
 */
export function mountApprovalActions(
  actions: HTMLElement,
  editHost: HTMLElement,
  options: ApprovalActionsOptions,
): ApprovalActions {
  const document = actions.ownerDocument;
  const pointers = collectTokenPointers(options.payload.args).slice(0, 20);
  const controls = createActionControls(actions, editHost, document, pointers);
  const context: ActionContext = {
    ...controls,
    actions,
    editHost,
    document,
    window: document.defaultView,
    listeners: new AbortController(),
    options,
    state: {
      busy: false,
      disposed: false,
      revealedValues: new Map(),
      maskTimer: undefined,
      editForm: undefined,
    },
  };
  bindActionHandlers(context);
  return {
    dispose() {
      disposeActions(context);
    },
    revealedValueCount() {
      return context.state.revealedValues.size;
    },
  };
}
