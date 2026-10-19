// SPDX-License-Identifier: Apache-2.0
/** Mounted CLI instructions for approval hosts without a usable app bridge. */
export interface ApprovalFallback {
  show(fallbackText?: string, approvalId?: string): void;
  hide(): void;
  dispose(): void;
}

function createCommand(
  document: Document,
  command: string,
  label: string,
  listeners: AbortController,
): HTMLElement {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = label;
  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = command;
  input.setAttribute("aria-label", `${label} command`);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy command";
  copy.setAttribute("aria-label", `Copy ${label.toLowerCase()} command`);
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
          status.textContent = "Command copied.";
        } catch {
          input.focus();
          input.select();
          status.textContent = "Copy unavailable. The command is selected for manual copying.";
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
export function createApprovalFallback(root: HTMLElement): ApprovalFallback {
  const document = root.ownerDocument;
  const listeners = new AbortController();
  const card = document.createElement("section");
  card.hidden = true;
  card.setAttribute("aria-labelledby", "approval-fallback-heading");
  const heading = document.createElement("h2");
  heading.id = "approval-fallback-heading";
  heading.textContent = "Use the command line";
  const instructions = document.createElement("p");
  const commands = document.createElement("div");
  card.append(heading, instructions, commands);
  root.append(card);

  return {
    show(fallbackText, approvalId) {
      const id = approvalId ?? "<id>";
      instructions.textContent =
        fallbackText ?? "The host bridge is unavailable. Resolve this approval from the CLI.";
      commands.replaceChildren(
        createCommand(document, `harness approvals approve ${id}`, "Approve", listeners),
        createCommand(document, `harness approvals deny ${id}`, "Deny", listeners),
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
