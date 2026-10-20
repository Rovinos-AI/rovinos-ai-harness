// SPDX-License-Identifier: Apache-2.0
import { parseTokenType } from "@harness/schemas/browser";
import { z } from "zod";
import { formatDate, formatMessage, getStrings } from "./strings.js";

const elicitationFieldSchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    title: z.string().max(500).optional(),
    description: z.string().max(1000).optional(),
    enum: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .max(100)
      .optional(),
  })
  .strict();

const elicitationFormSchema = z
  .object({
    type: z.literal("object"),
    properties: z
      .record(z.string().max(256), elicitationFieldSchema)
      .refine((properties) => Object.keys(properties).length <= 100),
    required: z.array(z.string().max(256)).max(100).optional(),
  })
  .strict();

let nextElicitationFormId = 0;
let nextConfirmationDialogId = 0;

/** Zod-inferred subset of MCP elicitation form schemas rendered by the kit. */
export type ElicitationFormSchema = z.infer<typeof elicitationFormSchema>;

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

/** Creates an accessible token pill, rendering arbitrary input strictly as text. */
export function createTokenPill(document: Document, token: string): HTMLSpanElement {
  const pill = element(document, "span", token);
  if (parseTokenType(token) !== undefined) {
    pill.className = "token";
    pill.setAttribute("role", "img");
    pill.setAttribute("aria-label", token);
    const parts = token.slice(1, -1).split("_");
    const index = parts.pop() ?? "";
    const type = parts.join(" ").toLowerCase();
    pill.textContent = formatMessage(getStrings(document.documentElement.lang).tokenLabel, {
      type,
      index,
    });
  }
  return pill;
}

/** Appends text with token pills, preserving all non-token content as text nodes. */
export function appendTokenText(parent: HTMLElement, text: string): void {
  const document = parent.ownerDocument;
  let offset = 0;
  for (const match of text.matchAll(/<[^<>]*>/gu)) {
    const token = match[0];
    if (parseTokenType(token) === undefined) {
      continue;
    }
    const preceding = element(document, "span", text.slice(offset, match.index));
    parent.append(preceding, createTokenPill(document, token));
    offset = match.index + token.length;
  }
  parent.append(element(document, "span", text.slice(offset)));
}

function readElicitationSchema(value: unknown): ElicitationFormSchema | undefined {
  const parsed = elicitationFormSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function formControl(
  document: Document,
  field: ElicitationFormSchema["properties"][string],
  name: string,
): HTMLInputElement | HTMLSelectElement {
  const type = field.type;
  if (field.enum !== undefined) {
    const select = element(document, "select");
    select.name = name;
    for (const [index, entry] of field.enum.entries()) {
      const option = element(document, "option", String(entry));
      option.value = String(index);
      select.add(option);
    }
    return select;
  }
  if (type === "boolean") {
    const input = element(document, "input");
    input.type = "checkbox";
    input.name = name;
    return input;
  }
  if (type === "number" || type === "integer") {
    const input = element(document, "input");
    input.type = "number";
    input.step = type === "integer" ? "1" : "any";
    input.name = name;
    return input;
  }
  const input = element(document, "input");
  input.type = "text";
  input.name = name;
  return input;
}

interface ElicitationControl {
  readonly control: HTMLInputElement | HTMLSelectElement;
  readonly field: ElicitationFormSchema["properties"][string];
}

type ElicitationValue =
  | { readonly kind: "value"; readonly value: string | number | boolean }
  | { readonly kind: "omit" }
  | { readonly kind: "invalid" };

function readElicitationValue(entry: ElicitationControl, required: boolean): ElicitationValue {
  const { control, field } = entry;
  if ("selectedIndex" in control) {
    const selected = field.enum?.[control.selectedIndex];
    return selected === undefined ? { kind: "invalid" } : { kind: "value", value: selected };
  }
  if ("checked" in control && control.type === "checkbox") {
    return { kind: "value", value: control.checked };
  }
  if ("type" in control && control.type === "number") {
    const rawValue = control.value.trim();
    if (rawValue === "") {
      return required ? { kind: "invalid" } : { kind: "omit" };
    }
    const numericValue = Number(rawValue);
    if (
      !Number.isFinite(numericValue) ||
      (field.type === "integer" && !Number.isInteger(numericValue))
    ) {
      return { kind: "invalid" };
    }
    return { kind: "value", value: numericValue };
  }
  if (required && control.value === "") {
    return { kind: "invalid" };
  }
  return { kind: "value", value: control.value };
}

function collectElicitationValues(
  values: ReadonlyMap<string, ElicitationControl>,
  required: ReadonlySet<string>,
): Record<string, string | number | boolean> | undefined {
  const result: [string, string | number | boolean][] = [];
  for (const [name, entry] of values) {
    const fieldValue = readElicitationValue(entry, required.has(name));
    if (fieldValue.kind === "invalid") {
      return undefined;
    }
    if (fieldValue.kind === "value") {
      result.push([name, fieldValue.value]);
    }
  }
  return Object.fromEntries(result);
}

/** Renders the supported object-form subset of an MCP elicitation schema. */
export function createElicitationForm(
  document: Document,
  untrustedSchema: unknown,
  onSubmit: (values: Readonly<Record<string, string | number | boolean>>) => void,
): HTMLFormElement {
  const form = element(document, "form");
  const schema = readElicitationSchema(untrustedSchema);
  if (schema === undefined) {
    form.append(createErrorState(document));
    return form;
  }
  const formId = nextElicitationFormId;
  nextElicitationFormId += 1;
  const values = new Map<string, ElicitationControl>();
  const required = new Set(schema.required ?? []);
  for (const [name, candidate] of Object.entries(schema.properties)) {
    const id = `elicitation-${String(formId)}-${String(values.size)}`;
    const label = element(document, "label", candidate.title ?? name);
    label.htmlFor = id;
    const control = formControl(document, candidate, name);
    control.id = id;
    control.required = required.has(name) && !("type" in control && control.type === "checkbox");
    if (candidate.description !== undefined) {
      const description = element(document, "span", candidate.description);
      description.id = `${id}-description`;
      control.setAttribute("aria-describedby", description.id);
      form.append(label, control, description);
    } else {
      form.append(label, control);
    }
    values.set(name, { control, field: candidate });
  }
  const submit = element(document, "button", getStrings(document.documentElement.lang).confirm);
  submit.type = "submit";
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = collectElicitationValues(values, required);
    if (result !== undefined) {
      onSubmit(result);
    }
  });
  return form;
}

/** Table column identifier and accessible header label. */
export interface DataTableColumn {
  readonly key: string;
  readonly label: string;
}

/** Renders a keyboard-scrollable data table using only native table elements. */
export function createDataTable(
  document: Document,
  caption: string,
  columns: readonly DataTableColumn[],
  rows: readonly Readonly<Record<string, string>>[],
): HTMLDivElement {
  const wrapper = element(document, "div");
  wrapper.className = "table-scroll";
  wrapper.tabIndex = 0;
  wrapper.setAttribute(
    "aria-label",
    formatMessage(getStrings(document.documentElement.lang).tableNavigation, { label: caption }),
  );
  const table = element(document, "table");
  table.append(element(document, "caption", caption));
  const head = element(document, "thead");
  const headerRow = element(document, "tr");
  for (const column of columns) {
    headerRow.append(element(document, "th", column.label));
  }
  head.append(headerRow);
  const body = element(document, "tbody");
  for (const row of rows) {
    const tableRow = element(document, "tr");
    for (const column of columns) {
      tableRow.append(element(document, "td", row[column.key] ?? ""));
    }
    body.append(tableRow);
  }
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

/** One localized item in a rendered timeline. */
export interface TimelineItem {
  readonly title: string;
  readonly description?: string;
  readonly at?: number;
}

/** Options used to render and localize a timeline. */
export interface TimelineOptions {
  readonly label: string;
  readonly items: readonly TimelineItem[];
  readonly locale?: string;
  readonly timeZone?: string;
}

/** Renders a semantic, localized ordered timeline. */
export function createTimeline(document: Document, options: TimelineOptions): HTMLOListElement {
  const { label, items, locale, timeZone } = options;
  const list = element(document, "ol");
  list.className = "timeline";
  list.setAttribute("aria-label", label);
  for (const item of items) {
    const entry = element(document, "li");
    entry.append(element(document, "h3", item.title));
    if (item.description !== undefined) {
      entry.append(element(document, "p", item.description));
    }
    if (item.at !== undefined) {
      entry.append(element(document, "time", formatDate(item.at, locale, timeZone)));
    }
    list.append(entry);
  }
  return list;
}

/** Visual state categories available to status badges. */
export type StatusKind = "success" | "warning" | "danger" | "info" | "neutral";

/** Renders a semantic status label with a theme-aware visual class. */
export function createStatusBadge(
  document: Document,
  kind: StatusKind,
  label: string,
): HTMLSpanElement {
  const badge = element(document, "span", label);
  badge.className = `status-badge status-${kind}`;
  badge.setAttribute("role", "status");
  return badge;
}

/** Renders an accessible native meter and clamps its value to the provided range. */
export function createMeter(
  document: Document,
  label: string,
  value: number,
  max: number,
): HTMLLabelElement {
  const wrapper = element(document, "label", `${label} `);
  const meter = element(document, "meter");
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  meter.min = 0;
  meter.max = safeMax;
  meter.value = Number.isFinite(value) ? Math.min(Math.max(value, 0), safeMax) : 0;
  meter.setAttribute("aria-label", label);
  wrapper.append(meter);
  return wrapper;
}

/** Displays a URL as text with its hostname highlighted; no link is created. */
export function createUrlDisplay(document: Document, value: string): HTMLElement {
  const display = element(document, "span");
  try {
    const parsed = new URL(value);
    const schemeEnd = value.indexOf("://");
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || schemeEnd < 0) {
      display.textContent = value;
      return display;
    }
    const authorityStart = schemeEnd + 3;
    const authority = value.slice(authorityStart).split(/[/?#]/u, 1)[0] ?? "";
    const hostStartInAuthority = authority.lastIndexOf("@") + 1;
    const domainOffset = authority
      .slice(hostStartInAuthority)
      .toLowerCase()
      .lastIndexOf(parsed.hostname.toLowerCase());
    if (domainOffset < 0) {
      display.textContent = value;
      return display;
    }
    const domainStart = authorityStart + hostStartInAuthority + domainOffset;
    const domainEnd = domainStart + parsed.hostname.length;
    const domain = element(document, "strong", parsed.hostname);
    display.append(
      element(document, "span", value.slice(0, domainStart)),
      domain,
      element(document, "span", value.slice(domainEnd)),
    );
  } catch {
    display.textContent = value;
  }
  return display;
}

/** Creates a native confirmation dialog with keyboard-operable actions. */
export function createConfirmationDialog(
  document: Document,
  options: {
    readonly title: string;
    readonly message: string;
    readonly confirmLabel: string;
    readonly cancelLabel: string;
    readonly onConfirm: () => void;
    readonly onCancel?: () => void;
  },
): HTMLDialogElement {
  const dialog = element(document, "dialog");
  const title = element(document, "h2", options.title);
  title.id = `kit-confirmation-title-${String(nextConfirmationDialogId)}`;
  nextConfirmationDialogId += 1;
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.setAttribute("aria-modal", "true");
  dialog.append(title, element(document, "p", options.message));
  const confirm = element(document, "button", options.confirmLabel);
  confirm.type = "button";
  confirm.addEventListener("click", () => {
    options.onConfirm();
    if (dialog.open) {
      dialog.close();
    }
  });
  const cancel = element(document, "button", options.cancelLabel);
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    options.onCancel?.();
    if (dialog.open) {
      dialog.close();
    }
  });
  dialog.addEventListener("cancel", () => {
    options.onCancel?.();
  });
  dialog.append(confirm, cancel);
  return dialog;
}

/** Creates a localized empty state. */
export function createEmptyState(
  document: Document,
  title?: string,
  message?: string,
): HTMLElement {
  const strings = getStrings(document.documentElement.lang);
  const section = element(document, "section");
  section.setAttribute("role", "status");
  section.append(
    element(document, "h2", title ?? strings.emptyTitle),
    element(document, "p", message ?? strings.emptyMessage),
  );
  return section;
}

/** Creates a localized error state without exposing implementation details. */
export function createErrorState(document: Document, message?: string): HTMLElement {
  const strings = getStrings(document.documentElement.lang);
  const section = element(document, "section");
  section.setAttribute("role", "alert");
  section.append(
    element(document, "h2", strings.errorTitle),
    element(document, "p", message ?? strings.errorMessage),
  );
  return section;
}
