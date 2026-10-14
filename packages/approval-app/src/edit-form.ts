// SPDX-License-Identifier: Apache-2.0
import {
  JsonValue,
  parseJson,
  type ApprovalPayload,
  type JsonValue as Json,
} from "@harness/schemas/browser";

type FormControl =
  | { readonly kind: "text"; readonly input: HTMLInputElement }
  | { readonly kind: "number"; readonly input: HTMLInputElement }
  | { readonly kind: "boolean"; readonly input: HTMLInputElement }
  | { readonly kind: "json"; readonly input: HTMLTextAreaElement };

interface FieldControl {
  readonly pointer: string;
  readonly original: Json | undefined;
  readonly control: FormControl;
  touched: boolean;
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

function pointerValue(value: Json, pointer: string): Json | undefined {
  if (pointer === "") {
    return value;
  }
  let current: Json | undefined = value;
  for (const part of pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) && index >= 0 ? current[index] : undefined;
    } else if (typeof current === "object" && current !== null) {
      current = Object.hasOwn(current, part) ? current[part] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

function createControl(document: Document, value: Json | undefined, id: string): FormControl {
  if (typeof value === "string" || value === undefined) {
    const input = element(document, "input");
    input.type = "text";
    input.value = value ?? "";
    input.id = id;
    return { kind: "text", input };
  }
  if (typeof value === "number") {
    const input = element(document, "input");
    input.type = "number";
    input.step = "any";
    input.value = String(value);
    input.id = id;
    return { kind: "number", input };
  }
  if (typeof value === "boolean") {
    const input = element(document, "input");
    input.type = "checkbox";
    input.checked = value;
    input.id = id;
    return { kind: "boolean", input };
  }
  const textarea = element(document, "textarea");
  textarea.value = JSON.stringify(value);
  textarea.id = id;
  return { kind: "json", input: textarea };
}

function readControlValue(control: FieldControl): Json | undefined {
  const { control: formControl } = control;
  if (formControl.kind === "json") {
    try {
      return parseJson(JsonValue, formControl.input.value);
    } catch {
      return undefined;
    }
  }
  if (formControl.kind === "text") {
    return formControl.input.value;
  }
  if (formControl.kind === "number") {
    if (formControl.input.value.trim() === "") {
      return undefined;
    }
    const number = Number(formControl.input.value);
    return Number.isFinite(number) ? number : undefined;
  }
  return formControl.input.checked;
}

/**
 * Builds a safe edit form with one typed control for each policy-approved pointer.
 *
 * @param document - Document that owns the approval view.
 * @param payload - Validated, tokenized approval payload.
 * @param onSubmit - Receives only changed, client-validated pointer edits.
 * @returns An accessible form element.
 */
export function createEditForm(
  document: Document,
  payload: ApprovalPayload,
  onSubmit: (edits: { readonly pointer: string; readonly value: Json }[]) => void,
): HTMLFormElement {
  const form = element(document, "form");
  form.setAttribute("aria-labelledby", "approval-edit-heading");
  form.append(element(document, "h2", "Edit approval"));
  form.querySelector("h2")?.setAttribute("id", "approval-edit-heading");
  const controls: FieldControl[] = [];
  let index = 0;
  for (const pointer of payload.editableFields) {
    const original = pointerValue(payload.args, pointer);
    const id = `approval-edit-${String(index)}`;
    const field = element(document, "div");
    const label = element(document, "label", pointer);
    label.htmlFor = id;
    const control = createControl(document, original, id);
    const fieldControl: FieldControl = { pointer, original, control, touched: false };
    control.input.addEventListener("input", () => {
      fieldControl.touched = true;
    });
    control.input.addEventListener("change", () => {
      fieldControl.touched = true;
    });
    const current = element(
      document,
      "p",
      `Current tokenized value: ${original === undefined ? "(not set)" : JSON.stringify(original)}`,
    );
    field.append(label, current, control.input);
    form.append(field);
    controls.push(fieldControl);
    index += 1;
  }
  const error = element(document, "p");
  error.setAttribute("role", "alert");
  form.append(error);
  const submit = element(document, "button", "Submit edits");
  submit.type = "submit";
  const cancel = element(document, "button", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    form.remove();
  });
  form.append(submit, cancel);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";
    const edits: { pointer: string; value: Json }[] = [];
    for (const control of controls) {
      const value = readControlValue(control);
      if (value === undefined) {
        error.textContent = "Enter a valid value.";
        control.control.input.focus();
        return;
      }
      if (control.original === undefined && value === "" && !control.touched) {
        continue;
      }
      if (JSON.stringify(value) !== JSON.stringify(control.original)) {
        edits.push({ pointer: control.pointer, value });
      }
    }
    onSubmit(edits);
  });
  return form;
}
