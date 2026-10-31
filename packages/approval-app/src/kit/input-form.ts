// SPDX-License-Identifier: Apache-2.0
import {
  formSchemaToZod,
  type FormSchema,
  type JsonValue,
} from "@rovinos/schemas/browser";
import { getStrings } from "./strings.js";

type FormProperty = FormSchema["properties"][string];
type FormControl = HTMLInputElement | HTMLSelectElement;

interface FormEntry {
  readonly control: FormControl;
  readonly field: FormProperty;
}

type StringField = Extract<FormProperty, { type: "string" }>;
type ArrayField = Extract<FormProperty, { type: "array" }>;
type FormValidator = ReturnType<typeof formSchemaToZod>;

let nextFormId = 0;

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

function arrayControl(
  document: Document,
  field: ArrayField,
  name: string,
  id: string,
): HTMLSelectElement {
  const select = element(document, "select");
  select.name = name;
  select.id = id;
  select.multiple = true;
  if ("enum" in field.items) {
    appendOptions(select, field.items.enum.map((value) => ({ value, label: value })));
  } else {
    appendOptions(
      select,
      field.items.anyOf.map(({ const: value, title }) => ({ value, label: title })),
    );
  }
  return select;
}

function choiceControl(
  document: Document,
  field: StringField,
  name: string,
  id: string,
): HTMLSelectElement {
  const select = element(document, "select");
  select.name = name;
  select.id = id;
  if (field.oneOf !== undefined) {
    appendOptions(
      select,
      field.oneOf.map(({ const: value, title }) => ({ value, label: title })),
    );
  } else if (field.enum !== undefined) {
    appendOptions(select, field.enum.map((value) => ({ value, label: value })));
  }
  return select;
}

function booleanControl(
  document: Document,
  field: Extract<FormProperty, { type: "boolean" }>,
  name: string,
  id: string,
): HTMLInputElement {
  const input = element(document, "input");
  input.type = "checkbox";
  input.name = name;
  input.id = id;
  if (field.default !== undefined) {
    input.checked = field.default;
  }
  return input;
}

function numberControl(
  document: Document,
  field: Extract<FormProperty, { type: "number" | "integer" }>,
  name: string,
  id: string,
): HTMLInputElement {
  const input = element(document, "input");
  input.type = "number";
  input.name = name;
  input.id = id;
  input.step = field.type === "integer" ? "1" : "any";
  if (field.minimum !== undefined) {
    input.min = String(field.minimum);
  }
  if (field.maximum !== undefined) {
    input.max = String(field.maximum);
  }
  if (field.default !== undefined) {
    input.value = String(field.default);
  }
  return input;
}

function stringControl(
  document: Document,
  field: StringField,
  name: string,
  id: string,
): HTMLInputElement {
  const input = element(document, "input");
  input.name = name;
  input.id = id;
  switch (field.format) {
    case "email":
      input.type = "email";
      break;
    case "uri":
      input.type = "url";
      break;
    case "date":
      input.type = "date";
      break;
    case "date-time":
      input.type = "datetime-local";
      break;
    case undefined:
      input.type = "text";
      break;
  }
  if (field.minLength !== undefined) {
    input.minLength = field.minLength;
  }
  if (field.maxLength !== undefined) {
    input.maxLength = field.maxLength;
  }
  if (field.pattern !== undefined) {
    input.pattern = field.pattern;
  }
  if (field.default !== undefined) {
    input.value = field.format === "date-time" ? datetimeLocalValue(field.default) : field.default;
  }
  return input;
}

function schemaFormControl(
  document: Document,
  field: FormProperty,
  name: string,
  id: string,
): FormControl {
  switch (field.type) {
    case "array":
      return arrayControl(document, field, name, id);
    case "boolean":
      return booleanControl(document, field, name, id);
    case "integer":
    case "number":
      return numberControl(document, field, name, id);
    case "string":
      if (field.enum !== undefined || field.oneOf !== undefined) {
        return choiceControl(document, field, name, id);
      }
      return stringControl(document, field, name, id);
  }
}

function appendOptions(
  select: HTMLSelectElement,
  options: readonly { readonly value: string; readonly label: string }[],
): void {
  for (const [index, option] of options.entries()) {
    const node = element(select.ownerDocument, "option", option.label);
    node.value = String(index);
    select.add(node);
  }
}

function isSelectControl(control: FormControl): control is HTMLSelectElement {
  return control.tagName === "SELECT";
}

function isInputControl(control: FormControl): control is HTMLInputElement {
  return control.tagName === "INPUT";
}

function datetimeLocalValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function arrayValue(entry: FormEntry, required: boolean): JsonValue | undefined {
  if (entry.field.type !== "array" || !isSelectControl(entry.control)) {
    return undefined;
  }
  const { field } = entry;
  const values = Array.from(entry.control.selectedOptions).flatMap((option) => {
    const index = Number(option.value);
    const value =
      "enum" in field.items ? field.items.enum[index] : field.items.anyOf[index]?.const;
    return value === undefined ? [] : [value];
  });
  if (values.length === 0 && !required && field.default === undefined) {
    return undefined;
  }
  return values;
}

function choiceValue(entry: FormEntry, required: boolean): JsonValue | undefined {
  if (entry.field.type !== "string" || !isSelectControl(entry.control)) {
    return undefined;
  }
  const selected = entry.control.selectedIndex;
  if (selected < 0) {
    return required ? "" : undefined;
  }
  return entry.field.oneOf?.[selected]?.const ?? entry.field.enum?.[selected];
}

function booleanValue(entry: FormEntry, required: boolean): JsonValue | undefined {
  if (entry.field.type !== "boolean" || !isInputControl(entry.control)) {
    return undefined;
  }
  const checked = entry.control.checked;
  if (required || entry.field.default !== undefined || checked) {
    return checked;
  }
  return undefined;
}

function numberValue(entry: FormEntry, required: boolean): JsonValue | undefined {
  if (
    (entry.field.type !== "number" && entry.field.type !== "integer") ||
    !isInputControl(entry.control)
  ) {
    return undefined;
  }
  const raw = entry.control.value.trim();
  if (raw === "") {
    if (required) {
      return Number.NaN;
    }
    return undefined;
  }
  return Number(raw);
}

function stringValue(entry: FormEntry, required: boolean): JsonValue | undefined {
  if (entry.field.type !== "string" || !isInputControl(entry.control)) {
    return undefined;
  }
  const raw = entry.control.value;
  if (raw === "" && !required && entry.field.default === undefined) {
    return undefined;
  }
  if (entry.field.format === "date-time" && raw !== "") {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return raw;
}

function formEntryValue(entry: FormEntry, required: boolean): JsonValue | undefined {
  switch (entry.field.type) {
    case "array":
      return arrayValue(entry, required);
    case "boolean":
      return booleanValue(entry, required);
    case "integer":
    case "number":
      return numberValue(entry, required);
    case "string":
      if (entry.field.enum !== undefined || entry.field.oneOf !== undefined) {
        return choiceValue(entry, required);
      }
      return stringValue(entry, required);
  }
}

function applySelectDefaults(entry: FormEntry): void {
  const control = entry.control;
  const field = entry.field;
  if (!isSelectControl(control)) {
    return;
  }
  if (field.type === "array" && field.default !== undefined) {
    const defaults = new Set(field.default);
    for (const option of Array.from(control.options)) {
      const index = Number(option.value);
      const value =
        "enum" in field.items
          ? field.items.enum[index]
          : field.items.anyOf[index]?.const;
      option.selected = value !== undefined && defaults.has(value);
    }
    return;
  }
  if (
    field.type === "string" &&
    (field.enum !== undefined || field.oneOf !== undefined)
  ) {
    if (field.default === undefined) {
      control.selectedIndex = -1;
      return;
    }
    if (field.oneOf !== undefined) {
      control.selectedIndex = field.oneOf.findIndex(
        ({ const: value }) => value === field.default,
      );
      return;
    }
    control.selectedIndex = field.enum?.indexOf(field.default) ?? -1;
  }
}

interface AppendFormFieldOptions {
  readonly form: HTMLFormElement;
  readonly controls: Map<string, FormEntry>;
  readonly name: string;
  readonly field: FormProperty;
  readonly index: number;
  readonly required: ReadonlySet<string>;
}

function appendFormField(options: AppendFormFieldOptions): void {
  const { form, controls, name, field, index, required } = options;
  const id = `input-${String(nextFormId)}-${String(index)}`;
  const label = element(form.ownerDocument, "label", field.title ?? name);
  label.htmlFor = id;
  const control = schemaFormControl(form.ownerDocument, field, name, id);
  control.required = required.has(name) && !(isInputControl(control) && control.type === "checkbox");
  const entry = { control, field };
  applySelectDefaults(entry);
  if (field.description !== undefined) {
    const description = element(form.ownerDocument, "span", field.description);
    description.id = `${id}-description`;
    control.setAttribute("aria-describedby", description.id);
    form.append(label, control, description);
  } else {
    form.append(label, control);
  }
  controls.set(name, entry);
}

function collectFormValues(
  controls: ReadonlyMap<string, FormEntry>,
  required: ReadonlySet<string>,
  error: HTMLElement,
  validator: FormValidator,
): Record<string, JsonValue> | undefined {
  const errorElement = error;
  const entries: [string, JsonValue][] = [];
  for (const [name, entry] of controls) {
    const value = formEntryValue(entry, required.has(name));
    entry.control.removeAttribute("aria-invalid");
    if (value !== undefined) {
      entries.push([name, value]);
    }
  }
  const values = Object.fromEntries(entries);
  const result = validator.safeParse(values);
  if (result.success) {
    errorElement.textContent = "";
    return values;
  }
  errorElement.textContent = getStrings(
    errorElement.ownerDocument.documentElement.lang,
  ).invalidInput;
  for (const issue of result.error.issues) {
    const fieldName = issue.path[0];
    if (typeof fieldName === "string") {
      controls.get(fieldName)?.control.setAttribute("aria-invalid", "true");
    }
  }
  return undefined;
}

/** Renders and validates the supported `FormSchema` fields using their shared Zod contract. */
export function createFormFromSchema(
  document: Document,
  schema: FormSchema,
  onSubmit: (values: Readonly<Record<string, JsonValue>>) => void,
): HTMLFormElement {
  const form = element(document, "form");
  form.className = "input-form";
  const controls = new Map<string, FormEntry>();
  const required = new Set(schema.required ?? []);
  const error = element(document, "p");
  error.id = `input-form-error-${String(nextFormId)}`;
  error.setAttribute("role", "alert");
  const validator = formSchemaToZod(schema);
  for (const [index, [name, field]] of Object.entries(schema.properties).entries()) {
    appendFormField({ form, controls, name, field, index, required });
  }
  nextFormId += 1;
  form.append(error);
  const submit = element(document, "button", getStrings(document.documentElement.lang).accept);
  submit.type = "submit";
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = collectFormValues(controls, required, error, validator);
    if (values !== undefined) {
      onSubmit(values);
    }
  });
  return form;
}
