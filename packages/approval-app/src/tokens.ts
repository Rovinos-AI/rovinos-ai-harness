// SPDX-License-Identifier: Apache-2.0
import { parseTokenType } from "@harness/schemas/browser";

/**
 * Appends text and accessible token pills without resolving values or interpreting markup.
 *
 * @param parent - Container owned by this view.
 * @param text - Tokenized display text.
 */
export function appendTokenText(parent: HTMLElement, text: string): void {
  const document = parent.ownerDocument;
  let offset = 0;
  for (const match of text.matchAll(/<[^<>]*>/gu)) {
    const token = match[0];
    if (parseTokenType(token) === undefined) {
      continue;
    }
    const preceding = document.createElement("span");
    preceding.textContent = text.slice(offset, match.index);
    const pill = document.createElement("span");
    pill.className = "token";
    pill.setAttribute("role", "img");
    pill.setAttribute("aria-label", token);
    pill.textContent = token.slice(1, -1).toLowerCase().replaceAll("_", " ");
    parent.append(preceding, pill);
    offset = match.index + token.length;
  }
  const remaining = document.createElement("span");
  remaining.textContent = text.slice(offset);
  parent.append(remaining);
}
