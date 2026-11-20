// SPDX-License-Identifier: Apache-2.0
import { reportsViewInputSchema, reportsViewResultSchema } from "./schema.js";
import { renderReport } from "./render.js";

function message(document: Document, text: string, role: "status" | "alert"): HTMLElement {
  const node = document.createElement("p");
  node.setAttribute("role", role);
  node.textContent = text;
  return node;
}

/** Report viewer state and safe render operations. */
export interface ReportsView {
  receiveInput(value: unknown): void;
  receiveResult(value: unknown): void;
}

/** Creates the report viewer, validating host-provided values before rendering. */
export function createReportsView(container: HTMLElement): ReportsView {
  const document = container.ownerDocument;
  return {
    receiveInput(value) {
      const input = reportsViewInputSchema.safeParse(value);
      container.replaceChildren(
        input.success
          ? message(document, `Opening ${input.data.kind} report…`, "status")
          : message(document, "Report could not be opened.", "alert"),
      );
    },
    receiveResult(value) {
      const report = reportsViewResultSchema.safeParse(value);
      if (!report.success) {
        container.replaceChildren(message(document, "Report could not be opened.", "alert"));
        return;
      }
      renderReport(container, report.data);
    },
  };
}
