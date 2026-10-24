// SPDX-License-Identifier: Apache-2.0
import { ResolveRequest, ResolveResponse, type ApprovalPayload } from "@rovinos/schemas/browser";
import type { AppTelemetry } from "@rovinos/app-telemetry";
import { createEditForm } from "./edit-form.js";
import { getStrings, type UiStrings } from "./kit/strings.js";
import { mountRevealFlow, type RevealFlow } from "./reveal.js";

/** Terminal outcome returned by the approval resolve tool. */
export type ApprovalDecision = "approve" | "deny" | "edit";
type AppTelemetryForActions = Pick<AppTelemetry<readonly ["ui.decision"]>, "record" | "flush">;

/** Tagged outcome from a host tool call; transport failures are not tool unavailability. */
export type ApprovalToolCallOutcome =
  | { readonly kind: "response"; readonly value: unknown }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failure" };

/** The host bridge methods used by the approval decision and reveal controls. */
export interface ApprovalActionsBridge {
  readonly callTool: (
    name: "harness.approvals.resolve" | "harness.approvals.reveal",
    args: Record<string, unknown>,
  ) => Promise<ApprovalToolCallOutcome>;
}

/** Dependencies injected into the approval actions for host calls and safe telemetry. */
export interface ApprovalActionsOptions {
  readonly approvalId: string;
  readonly payload: ApprovalPayload;
  readonly locale?: () => string;
  readonly isExpired: () => boolean;
  readonly bridge: ApprovalActionsBridge;
  readonly telemetry: AppTelemetryForActions;
  readonly reportError: (code: "resolve_failed" | "reveal_failed") => void;
  readonly decisionDurationMs: () => number;
  readonly flushInteractions: () => void;
  readonly renderRevealed: (values: ReadonlyMap<string, string>) => void;
  readonly onDecision: (decision: ApprovalDecision) => void;
  readonly onResolveUnavailable?: () => void;
}

/** Mounted action controls and a non-sensitive state hook for expiry tests. */
export interface ApprovalActions {
  dispose(): void;
  revealedValueCount(): number;
}

interface ActionControls {
  readonly status: HTMLElement;
}

interface ActionContext extends ActionControls {
  readonly actions: HTMLElement;
  readonly editHost: HTMLElement;
  readonly document: Document;
  readonly listeners: AbortController;
  readonly options: ApprovalActionsOptions;
  revealFlow: RevealFlow | undefined;
  readonly state: {
    busy: boolean;
    disposed: boolean;
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

type ErrorStringKey = keyof Pick<
  UiStrings,
  | "errorApprovalMissing"
  | "errorAlreadyResolved"
  | "errorRunNotSuspended"
  | "errorResolutionConflict"
  | "errorInvalidEdit"
  | "errorEditNotAllowed"
>;

const errorMessages: Readonly<Record<string, ErrorStringKey>> = {
  approval_not_found: "errorApprovalMissing",
  approval_already_resolved: "errorAlreadyResolved",
  approval_run_not_suspended: "errorRunNotSuspended",
  approval_resolution_conflict: "errorResolutionConflict",
  edit_invalid: "errorInvalidEdit",
  edit_not_allowed: "errorEditNotAllowed",
};

function errorMessage(code: string | undefined, locale: string | undefined): string {
  const mapped = code === undefined ? undefined : errorMessages[code];
  if (mapped !== undefined) {
    return getStrings(locale)[mapped];
  }
  return getStrings(locale).errorResolve;
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

function createActionControls(actions: HTMLElement, document: Document): ActionControls {
  const status = element(document, "p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  actions.after(status);
  return { status };
}

function setBusy(context: ActionContext, busy: boolean): void {
  const state = context.state;
  state.busy = busy;
  const expired = context.options.isExpired();
  for (const control of context.actions.querySelectorAll("button")) {
    control.disabled = busy || expired;
  }
  for (const control of context.editHost.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
  >("button, input, textarea")) {
    control.disabled = busy || expired;
  }
}

const isExpired = (context: ActionContext): boolean => context.options.isExpired();

function reportError(context: ActionContext, code: UiErrorCode, message: string): void {
  const { status } = context;
  status.textContent = message;
  context.options.reportError(code);
}

function decisionStatus(decision: ApprovalDecision, locale: string | undefined): string {
  const strings = getStrings(locale);
  return {
    approve: strings.approvalGranted,
    deny: strings.approvalDenied,
    edit: strings.editsSubmitted,
  }[decision];
}

function handleResolveResult(
  context: ActionContext,
  decision: ApprovalDecision,
  result: ApprovalToolCallOutcome,
  decisionDurationMs: number,
): void {
  const { status, options } = context;
  if (result.kind === "unavailable" && options.onResolveUnavailable !== undefined) {
    options.onResolveUnavailable();
    return;
  }
  if (result.kind !== "response") {
    reportError(context, "resolve_failed", errorMessage(undefined, options.locale?.()));
    setBusy(context, false);
    return;
  }
  const response = ResolveResponse.safeParse(result.value);
  if (!response.success || !response.data.ok) {
    const code = response.success ? response.data.code : undefined;
    reportError(context, "resolve_failed", errorMessage(code, options.locale?.()));
    setBusy(context, false);
    return;
  }
  options.telemetry.record("ui.decision", { decision }, decisionDurationMs);
  void options.telemetry.flush();
  options.flushInteractions();
  status.textContent = decisionStatus(decision, options.locale?.());
  options.onDecision(decision);
  context.state.editForm?.remove();
  setBusy(context, true);
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
  const decisionDurationMs = context.options.decisionDurationMs();
  const request = ResolveRequest.safeParse({
    approvalId: context.options.approvalId,
    decision,
    ...(edits === undefined ? {} : { edits }),
  });
  if (!request.success) {
    reportError(context, "resolve_failed", getStrings(context.options.locale?.()).errorResolve);
    return;
  }
  setBusy(context, true);
  status.textContent = getStrings(context.options.locale?.()).submittingDecision;
  try {
    const result = await context.options.bridge.callTool("harness.approvals.resolve", request.data);
    handleResolveResult(context, decision, result, decisionDurationMs);
  } catch {
    reportError(context, "resolve_failed", errorMessage(undefined, context.options.locale?.()));
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
      status.textContent = getStrings(context.options.locale?.()).noChanges;
      return;
    }
    void resolveDecision(context, "edit", edits);
  });
  context.editHost.append(state.editForm);
  status.textContent = getStrings(context.options.locale?.()).editingApproval;
}

function bindActionHandlers(context: ActionContext): void {
  button(
    context.actions,
    getStrings(context.options.locale?.()).approve,
    () => void resolveDecision(context, "approve"),
    context.listeners.signal,
  );
  button(
    context.actions,
    getStrings(context.options.locale?.()).deny,
    () => void resolveDecision(context, "deny"),
    context.listeners.signal,
  );
  button(
    context.actions,
    getStrings(context.options.locale?.()).edit,
    () => {
      openEditForm(context);
    },
    context.listeners.signal,
  );
}

function disposeActions(context: ActionContext): void {
  const { state } = context;
  state.disposed = true;
  context.revealFlow?.dispose();
  state.editForm?.remove();
  context.listeners.abort();
  context.status.remove();
}

/**
 * Wires the approval view to its host-local decision and reveal tools.
 *
 * @param actions - Existing action navigation rendered by the approval view.
 * @param editHost - Container for the policy-approved edit form.
 * @param options - Approval identity, validated payload, host bridge, and metadata telemetry.
 * @returns Cleanup and a test hook that exposes only a value count.
 */
export function mountApprovalActions(
  actions: HTMLElement,
  editHost: HTMLElement,
  options: ApprovalActionsOptions,
): ApprovalActions {
  const document = actions.ownerDocument;
  const controls = createActionControls(actions, document);
  const context: ActionContext = {
    ...controls,
    actions,
    editHost,
    document,
    listeners: new AbortController(),
    options,
    revealFlow: undefined,
    state: {
      busy: false,
      disposed: false,
      editForm: undefined,
    },
  };
  context.revealFlow = mountRevealFlow(actions, {
    approvalId: options.approvalId,
    payload: options.payload,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    isExpired: options.isExpired,
    bridge: {
      callTool: async (name, args) => {
        const result = await options.bridge.callTool(name, args);
        if (result.kind !== "response") {
          throw new Error("reveal_failed");
        }
        return result.value;
      },
    },
    status: context.status,
    renderRevealed: options.renderRevealed,
    isBusy: () => context.state.busy,
    isDisposed: () => context.state.disposed,
    setBusy: (busy) => {
      setBusy(context, busy);
    },
    reportError: (message) => {
      reportError(context, "reveal_failed", message);
    },
  });
  bindActionHandlers(context);
  return {
    dispose() {
      disposeActions(context);
    },
    revealedValueCount() {
      return context.revealFlow?.revealedValueCount() ?? 0;
    },
  };
}
