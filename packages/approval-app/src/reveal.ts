// SPDX-License-Identifier: Apache-2.0
import {
  parseTokenType,
  RevealRequest,
  RevealResponse,
  type ApprovalPayload,
} from "@rovinos/schemas/browser";
import { formatMessage, getStrings } from "./kit/strings.js";

/** Host and view callbacks required by the time-limited sensitive-value reveal. */
export interface RevealFlowOptions {
  readonly approvalId: string;
  readonly payload: ApprovalPayload;
  readonly locale?: () => string;
  readonly isExpired: () => boolean;
  readonly bridge: {
    readonly callTool: (
      name: "harness.approvals.reveal",
      args: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  readonly status: HTMLElement;
  readonly renderRevealed: (values: ReadonlyMap<string, string>) => void;
  readonly isBusy: () => boolean;
  readonly isDisposed: () => boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly reportError: (message: string) => void;
}

/** Reveal controls that can be cleaned up without exposing revealed values. */
export interface RevealFlow {
  dispose(): void;
  revealedValueCount(): number;
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

function createConfirmation(
  actions: HTMLElement,
  document: Document,
  fieldCount: number,
  locale: string | undefined,
): {
  readonly reveal: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;
  readonly confirmButton: HTMLButtonElement;
  readonly cancelButton: HTMLButtonElement;
} {
  const strings = getStrings(locale);
  const reveal = element(document, "button", strings.revealValues);
  reveal.type = "button";
  reveal.disabled = fieldCount === 0;
  actions.append(reveal);

  const dialog = element(document, "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "approval-reveal-confirmation");
  const text = element(
    document,
    "p",
    formatMessage(strings.revealConfirmation, { count: fieldCount }, locale),
  );
  text.id = "approval-reveal-confirmation";
  const confirmButton = element(document, "button", strings.showRawValues);
  confirmButton.type = "button";
  const cancelButton = element(document, "button", strings.cancel);
  cancelButton.type = "button";
  dialog.append(text, confirmButton, cancelButton);
  actions.after(dialog);
  return { reveal, dialog, confirmButton, cancelButton };
}

function containDialogFocus(dialog: HTMLDialogElement, document: Document): void {
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") {
      return;
    }
    const controls = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  });
}

function shouldSkipReveal(options: RevealFlowOptions, pointers: readonly string[]): boolean {
  return options.isBusy() || options.isDisposed() || pointers.length === 0 || options.isExpired();
}

async function requestRevealedValues(
  options: RevealFlowOptions,
  pointers: readonly string[],
): Promise<ReadonlyMap<string, string> | undefined> {
  const request = RevealRequest.safeParse({ approvalId: options.approvalId, pointers });
  if (!request.success) {
    options.reportError(getStrings(options.locale?.()).errorReveal);
    return undefined;
  }
  const response = RevealResponse.safeParse(
    await options.bridge.callTool("harness.approvals.reveal", request.data),
  );
  if (!response.success) {
    options.reportError(getStrings(options.locale?.()).errorReveal);
    return undefined;
  }
  if (options.isDisposed()) {
    return undefined;
  }
  const permitted = new Set(pointers);
  const values = new Map<string, string>();
  for (const { pointer, value } of response.data.values) {
    if (permitted.has(pointer)) {
      values.set(pointer, value);
    }
  }
  return values;
}

function createRevealController(
  pointers: readonly string[],
  options: RevealFlowOptions,
  window: Window | null,
): {
  readonly reveal: () => Promise<void>;
  readonly dispose: () => void;
  readonly revealedValueCount: () => number;
} {
  const revealedValues = new Map<string, string>();
  const revealStatus = getStrings(options.locale?.()).revealedFor;
  let maskTimer: number | undefined;

  const showReveal = async (): Promise<void> => {
    if (shouldSkipReveal(options, pointers)) {
      return;
    }
    options.setBusy(true);
    const { status } = options;
    status.textContent = getStrings(options.locale?.()).revealingValues;
    try {
      const values = await requestRevealedValues(options, pointers);
      if (values === undefined) {
        return;
      }
      revealedValues.clear();
      for (const [pointer, value] of values) {
        revealedValues.set(pointer, value);
      }
      options.renderRevealed(revealedValues);
      status.textContent = revealStatus;
      if (maskTimer !== undefined) {
        window?.clearTimeout(maskTimer);
      }
      maskTimer = window?.setTimeout(() => {
        revealedValues.clear();
        options.renderRevealed(revealedValues);
        if (status.textContent === revealStatus) {
          status.textContent = getStrings(options.locale?.()).hiddenValues;
        }
        maskTimer = undefined;
      }, 30_000);
    } catch {
      options.reportError(getStrings(options.locale?.()).errorReveal);
    } finally {
      options.setBusy(false);
    }
  };

  return {
    reveal: showReveal,
    dispose() {
      if (maskTimer !== undefined) {
        window?.clearTimeout(maskTimer);
      }
      revealedValues.clear();
      options.renderRevealed(revealedValues);
    },
    revealedValueCount: () => revealedValues.size,
  };
}

function bindRevealEvents(
  controls: ReturnType<typeof createConfirmation>,
  options: RevealFlowOptions,
  pointers: readonly string[],
  dependencies: {
    readonly listeners: AbortController;
    readonly showReveal: () => Promise<void>;
    readonly document: Document;
  },
): void {
  const { listeners, showReveal, document } = dependencies;
  const { reveal, dialog, confirmButton, cancelButton } = controls;
  const closeConfirmation = (): void => {
    options.setBusy(false);
    if (dialog.open) {
      dialog.close();
    }
  };
  reveal.addEventListener(
    "click",
    () => {
      if (
        options.isBusy() ||
        options.isDisposed() ||
        pointers.length === 0 ||
        options.isExpired()
      ) {
        return;
      }
      options.setBusy(true);
      try {
        dialog.showModal();
        confirmButton.focus();
      } catch {
        options.setBusy(false);
        options.reportError(getStrings(options.locale?.()).errorReveal);
      }
    },
    { signal: listeners.signal },
  );
  confirmButton.addEventListener(
    "click",
    () => {
      closeConfirmation();
      void showReveal();
    },
    { signal: listeners.signal },
  );
  cancelButton.addEventListener("click", closeConfirmation, { signal: listeners.signal });
  dialog.addEventListener(
    "cancel",
    (event) => {
      event.preventDefault();
      closeConfirmation();
    },
    { signal: listeners.signal },
  );
  dialog.addEventListener(
    "close",
    () => {
      if (reveal.isConnected) {
        reveal.focus();
      }
    },
    { signal: listeners.signal },
  );
  containDialogFocus(dialog, document);
}

/**
 * Mounts a modal reveal confirmation and manages values in memory until masking or disposal.
 *
 * @param actions - Navigation containing the decision and reveal buttons.
 * @param options - Validated payload, host bridge, status, and cleanup callbacks.
 * @returns A disposer and a test hook exposing only the number of revealed values.
 */
export function mountRevealFlow(actions: HTMLElement, options: RevealFlowOptions): RevealFlow {
  const document = actions.ownerDocument;
  const pointers = collectTokenPointers(options.payload.args).slice(0, 20);
  const controls = createConfirmation(actions, document, pointers.length, options.locale?.());
  const listeners = new AbortController();
  const controller = createRevealController(pointers, options, document.defaultView);
  bindRevealEvents(controls, options, pointers, {
    listeners,
    showReveal: controller.reveal,
    document,
  });
  return {
    dispose() {
      options.setBusy(false);
      if (controls.dialog.open) {
        controls.dialog.close();
      }
      controller.dispose();
      listeners.abort();
      controls.dialog.remove();
      controls.reveal.remove();
    },
    revealedValueCount: controller.revealedValueCount,
  };
}
