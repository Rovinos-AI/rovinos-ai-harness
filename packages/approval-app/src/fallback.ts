// SPDX-License-Identifier: Apache-2.0
import { formatMessage, getStrings } from "./kit/strings.js";

/** Mounted CLI instructions for approval hosts without a usable app bridge. */
export interface ApprovalFallback {
  show(fallbackText?: string, approvalId?: string): void;
  hide(): void;
  dispose(): void;
}

function createCommand(options: {
  readonly document: Document;
  readonly command: string;
  readonly label: string;
  readonly locale: string | undefined;
  readonly listeners: AbortController;
}): HTMLElement {
  const { document, command, label, locale, listeners } = options;
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = command;
  input.setAttribute("aria-label", formatMessage(getStrings(locale).commandLabel, { label }));
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = getStrings(locale).copyCommand;
  copy.setAttribute(
    "aria-label",
    formatMessage(getStrings(locale).copyCommandLabel, { label: label.toLowerCase() }),
  );
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  copy.addEventListener(
    "click",
    () => {
      void (async () => {
        try {
          const clipboard = document.defaultView?.navigator.clipboard;
          if (clipboard === undefined) {
            throw new Error("clipboard_unavailable");
          }
          await clipboard.writeText(input.value);
          status.textContent = getStrings(locale).commandCopied;
        } catch {
          input.focus();
          input.select();
          status.textContent = getStrings(locale).copyUnavailable;
        }
      })();
    },
    { signal: listeners.signal },
  );
  section.append(heading, input, copy, status);
  return section;
}

/**
 * Creates safe, selectable CLI instructions without replacing the approval view.
 *
 * @param root - Approval app container.
 * @returns Methods to show, hide, or dispose of the fallback card.
 */
export function createApprovalFallback(root: HTMLElement, locale?: () => string): ApprovalFallback {
  const document = root.ownerDocument;
  const listeners = new AbortController();
  const card = document.createElement("section");
  card.hidden = true;
  card.setAttribute("aria-labelledby", "approval-fallback-heading");
  const heading = document.createElement("h2");
  heading.id = "approval-fallback-heading";
  heading.textContent = getStrings(locale?.()).useCommandLine;
  const instructions = document.createElement("p");
  const commands = document.createElement("div");
  card.append(heading, instructions, commands);
  let mounted = false;

  return {
    show(fallbackText, approvalId) {
      if (!mounted) {
        root.append(card);
        mounted = true;
      }
      const id = approvalId ?? "<id>";
      instructions.textContent = fallbackText ?? getStrings(locale?.()).fallbackUnavailable;
      commands.replaceChildren(
        createCommand({
          document,
          command: formatMessage(getStrings(locale?.()).approveCliCommand, { id }),
          label: getStrings(locale?.()).approveCommand,
          locale: locale?.(),
          listeners,
        }),
        createCommand({
          document,
          command: formatMessage(getStrings(locale?.()).denyCliCommand, { id }),
          label: getStrings(locale?.()).denyCommand,
          locale: locale?.(),
          listeners,
        }),
      );
      card.hidden = false;
    },
    hide() {
      card.hidden = true;
    },
    dispose() {
      listeners.abort();
      card.remove();
    },
  };
}
