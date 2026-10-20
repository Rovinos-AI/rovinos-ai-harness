// SPDX-License-Identifier: Apache-2.0
// Task 5.3 renders only; decision and reveal handlers belong to task 5.4.
import {
  ApprovalAppInputSchema,
  ApprovalPayloadSchema,
  type ApprovalPayload,
  type JsonValue,
} from "@harness/schemas/browser";
import { appendTokenText } from "./kit/components.js";
import { formatMessage, getStrings } from "./kit/strings.js";

type ApprovalDecision = "approve" | "deny" | "edit";

/** Payload DOM and reveal renderer passed to the host action wiring. */
export interface ApprovalPayloadContext {
  readonly payload: ApprovalPayload;
  readonly approvalId: string | undefined;
  readonly isExpired: () => boolean;
  readonly actions: HTMLElement;
  readonly editHost: HTMLElement;
  readonly renderRevealed: (values: ReadonlyMap<string, string>) => void;
  readonly onDecision: (decision: ApprovalDecision) => void;
}

/** Injected view dependencies; errors contain only the closed payload-invalid code. */
export interface ApprovalViewOptions {
  readonly clock: { now(): number };
  readonly onError: (code: "payload_invalid") => void;
  readonly locale?: () => string;
  readonly onPayload?: (context: ApprovalPayloadContext) => (() => void) | undefined;
}

/** One approval view with an explicit refresh hook for its injected clock. */
export interface ApprovalView {
  receive(input: unknown): boolean;
  tick(): void;
  dispose(): void;
}

interface ApprovalViewDom {
  readonly document: Document;
  readonly heading: HTMLElement;
  readonly status: HTMLElement;
  readonly content: HTMLElement;
}

interface ArgumentRenderState {
  readonly pointer: string;
  readonly revealed: ReadonlyMap<string, string>;
}

interface PayloadRenderOptions extends ApprovalViewDom {
  readonly payload: ApprovalPayload;
  readonly approvalId: string | undefined;
  readonly viewOptions: ApprovalViewOptions;
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

function pointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function argumentNode(
  document: Document,
  value: JsonValue,
  label: string,
  state: ArgumentRenderState,
): HTMLElement {
  const raw = state.revealed.get(state.pointer);
  if (raw !== undefined) {
    const revealed = document.createElement("div");
    revealed.textContent =
      formatMessage(getStrings(document.documentElement.lang).argumentValue, { label }) + raw;
    return revealed;
  }
  if (typeof value !== "object" || value === null) {
    const leaf = element(
      document,
      "div",
      formatMessage(getStrings(document.documentElement.lang).argumentValue, { label }),
    );
    appendTokenText(leaf, typeof value === "string" ? JSON.stringify(value) : String(value));
    return leaf;
  }
  const branch = element(document, "details");
  branch.open = true;
  const entries = Object.entries(value);
  const strings = getStrings(document.documentElement.lang);
  const empty = entries.length === 0 ? strings.emptySuffix : "";
  const summary = Array.isArray(value)
    ? formatMessage(
        strings.argumentArray,
        {
          label,
          count: value.length,
          items: value.length === 1 ? strings.oneItem : strings.manyItems,
          empty,
        },
        document.documentElement.lang,
      )
    : formatMessage(strings.argumentObject, { label, empty });
  branch.append(element(document, "summary", summary));
  const children = element(document, "ul");
  for (const [key, child] of entries) {
    const item = element(document, "li");
    const segment = Array.isArray(value) ? key : pointerSegment(key);
    item.append(
      argumentNode(document, child, key, {
        pointer: `${state.pointer}/${segment}`,
        revealed: state.revealed,
      }),
    );
    children.append(item);
  }
  branch.append(children);
  return branch;
}

function addMetadata(document: Document, row: HTMLElement, label: string, value: string): void {
  row.append(element(document, "dt", label), element(document, "dd", value));
}

function decisionStatus(decision: ApprovalDecision, locale: string | undefined): string {
  const strings = getStrings(locale);
  return {
    approve: strings.approvalGranted,
    deny: strings.approvalDenied,
    edit: strings.editsSubmitted,
  }[decision];
}

function updatePendingStatus(
  status: HTMLElement,
  expired: boolean,
  locale: string | undefined,
): void {
  const strings = getStrings(locale);
  const nextStatus = expired ? strings.expiredStatus : strings.pendingStatus;
  const liveStatus = status;
  if (liveStatus.textContent !== nextStatus) {
    liveStatus.textContent = nextStatus;
  }
}

function createViewDom(root: HTMLElement): ApprovalViewDom {
  const document = root.ownerDocument;
  const strings = getStrings(document.documentElement.lang);
  const main = element(document, "main");
  const heading = element(document, "h1", strings.waitingHeading);
  heading.tabIndex = -1;
  const status = element(document, "p", strings.waitingStatus);
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = element(document, "div");
  main.append(heading, status, content);
  root.replaceChildren(main);
  heading.focus();
  return { document, heading, status, content };
}

function createPayloadMetadata(
  document: Document,
  payload: ApprovalPayload,
  strings: ReturnType<typeof getStrings>,
): { readonly metadata: HTMLElement; readonly expiry: HTMLElement } {
  const metadata = element(document, "dl");
  addMetadata(document, metadata, strings.tool, payload.toolId);
  addMetadata(document, metadata, strings.rule, payload.ruleId);
  addMetadata(document, metadata, strings.reason, payload.reason);
  const expiry = element(document, "dd");
  metadata.append(element(document, "dt", strings.expiry), expiry);
  return { metadata, expiry };
}

function createPayloadActions(
  document: Document,
  payload: ApprovalPayload,
  strings: ReturnType<typeof getStrings>,
): HTMLElement {
  const actions = element(document, "nav");
  actions.setAttribute("aria-label", strings.approvalActions);
  const labels =
    payload.editableFields.length > 0
      ? [strings.approve, strings.deny, strings.edit]
      : [strings.approve, strings.deny];
  for (const label of labels) {
    const control = element(document, "button", label);
    control.type = "button";
    actions.append(control);
  }
  return actions;
}

function createPayloadView(options: PayloadRenderOptions): {
  readonly refresh: () => void;
  readonly cleanup: () => void;
} {
  const { document, heading, status, content, payload, approvalId, viewOptions } = options;
  const strings = getStrings(viewOptions.locale?.() ?? document.documentElement.lang);
  heading.replaceChildren();
  appendTokenText(heading, payload.summary);
  const { metadata, expiry } = createPayloadMetadata(document, payload, strings);

  const args = element(document, "section");
  args.setAttribute("aria-label", strings.arguments);
  const argumentTree = element(document, "div");
  args.append(element(document, "h2", strings.arguments), argumentTree);
  const renderRevealed = (revealed: ReadonlyMap<string, string>): void => {
    argumentTree.replaceChildren(
      argumentNode(document, payload.args, strings.arguments, { pointer: "", revealed }),
    );
  };
  const isExpired = (): boolean =>
    payload.expiresAt !== undefined && payload.expiresAt <= viewOptions.clock.now();
  renderRevealed(new Map());

  const actions = createPayloadActions(document, payload, strings);
  const editHost = element(document, "div");
  content.append(metadata, args, actions, editHost);
  let terminalDecision: ApprovalDecision | undefined;
  const onDecision = (decision: ApprovalDecision): void => {
    terminalDecision = decision;
    status.textContent = decisionStatus(decision, viewOptions.locale?.());
    disableActions();
  };
  const disableActions = (): void => {
    for (const control of actions.querySelectorAll("button")) {
      control.disabled = true;
    }
    for (const control of editHost.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
    >("button, input, textarea")) {
      control.disabled = true;
    }
  };
  const cleanup =
    viewOptions.onPayload?.({
      payload,
      approvalId,
      isExpired,
      actions,
      editHost,
      renderRevealed,
      onDecision,
    }) ?? (() => undefined);

  const refresh = (): void => {
    const remaining =
      payload.expiresAt === undefined ? undefined : payload.expiresAt - viewOptions.clock.now();
    const expired = isExpired();
    expiry.textContent =
      remaining === undefined
        ? strings.noExpiry
        : formatMessage(
            strings.secondsRemaining,
            { seconds: Math.max(0, Math.ceil(remaining / 1000)) },
            viewOptions.locale?.(),
          );
    if (terminalDecision === undefined) {
      updatePendingStatus(status, expired, viewOptions.locale?.());
    }
    if (expired || terminalDecision !== undefined) {
      disableActions();
    }
  };
  return { refresh, cleanup };
}

/**
 * Mounts the token-only approval screen and validates every delivered payload.
 *
 * @param root - Empty app container.
 * @param options - Injected wall clock and metadata-only error reporter.
 * @returns Payload receiver and countdown refresh hook.
 */
export function createApprovalView(root: HTMLElement, options: ApprovalViewOptions): ApprovalView {
  const dom = createViewDom(root);
  let refresh = (): void => undefined;
  let cleanupActions = (): void => undefined;
  let previousContentKey: string | undefined;

  function receive(input: unknown): boolean {
    const appInput = ApprovalAppInputSchema.safeParse(input);
    const parsed = ApprovalPayloadSchema.safeParse(
      appInput.success ? appInput.data.payload : input,
    );
    if (!parsed.success) {
      options.onError("payload_invalid");
    }
    const contentKey = parsed.success
      ? JSON.stringify({
          payload: parsed.data,
          approvalId: appInput.success ? appInput.data.approvalId : undefined,
        })
      : "invalid";
    if (contentKey === previousContentKey) {
      return false;
    }
    previousContentKey = undefined;
    cleanupActions();
    cleanupActions = (): void => undefined;
    dom.content.replaceChildren();
    refresh = (): void => undefined;
    if (!parsed.success) {
      const strings = getStrings(options.locale?.() ?? dom.document.documentElement.lang);
      dom.heading.textContent = strings.invalidHeading;
      if (dom.status.textContent !== strings.invalidStatus) {
        dom.status.textContent = strings.invalidStatus;
      }
      dom.heading.focus();
      previousContentKey = contentKey;
      return true;
    }
    const rendered = createPayloadView({
      ...dom,
      payload: parsed.data,
      approvalId: appInput.success ? appInput.data.approvalId : undefined,
      viewOptions: options,
    });
    cleanupActions = rendered.cleanup;
    refresh = rendered.refresh;
    refresh();
    dom.heading.focus();
    previousContentKey = contentKey;
    return true;
  }

  return {
    receive,
    tick() {
      refresh();
    },
    dispose() {
      cleanupActions();
      cleanupActions = (): void => undefined;
    },
  };
}
