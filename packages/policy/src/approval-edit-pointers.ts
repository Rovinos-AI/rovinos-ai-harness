// SPDX-License-Identifier: Apache-2.0
import { JsonPointerSchema } from "@rovinos/schemas";
import type { JsonPointer, JsonValue } from "@rovinos/schemas";
import type { ApprovalEdit } from "./approval-edits.js";
import type { ApprovalPayload } from "./approval-payload.js";

class InvalidEditPathError extends Error {}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(copyJson);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyJson(child)]));
  }
  return value;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => {
        const other = right[index];
        return other !== undefined && jsonValuesEqual(value, other);
      })
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => {
        const value = left[key];
        const other = right[key];
        return (
          Object.hasOwn(right, key) &&
          value !== undefined &&
          other !== undefined &&
          jsonValuesEqual(value, other)
        );
      })
    );
  }
  return false;
}

function pointerSegments(pointer: JsonPointer): string[] {
  return pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isInsideEditableField(pointer: JsonPointer, field: JsonPointer): boolean {
  return field === "" || pointer === field || pointer.startsWith(`${field}/`);
}

/** Converts whole-argument edits into deterministic JSON Pointer operations. */
export function diffToEdits(before: JsonValue, after: JsonValue): ApprovalEdit[] {
  return collectChangedEdits(before, after);
}

function collectChangedEdits(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path = "",
): ApprovalEdit[] {
  if (before === undefined) {
    return after === undefined ? [] : [{ pointer: JsonPointerSchema.parse(path), value: after }];
  }
  if (after === undefined) {
    return [{ pointer: JsonPointerSchema.parse(path), remove: true }];
  }
  if (jsonValuesEqual(before, after)) {
    return [];
  }
  if (isJsonObject(before) && isJsonObject(after)) {
    return Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).flatMap((key) =>
      collectChangedEdits(
        before[key],
        after[key],
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      ),
    );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const commonLength = Math.min(before.length, after.length);
    const replacements = Array.from({ length: commonLength }, (_, index) =>
      collectChangedEdits(before[index], after[index], `${path}/${String(index)}`),
    ).flat();
    const removals = Array.from(
      { length: Math.max(0, before.length - after.length) },
      (_, offset) => ({
        pointer: JsonPointerSchema.parse(`${path}/${String(before.length - offset - 1)}`),
        remove: true as const,
      }),
    );
    const additions = Array.from(
      { length: Math.max(0, after.length - before.length) },
      (_, offset) => ({
        pointer: JsonPointerSchema.parse(`${path}/${String(before.length + offset)}`),
        value: after[before.length + offset] ?? null,
      }),
    );
    return [...replacements, ...removals, ...additions];
  }
  return [{ pointer: JsonPointerSchema.parse(path), value: after }];
}

/** Returns whether every changed leaf falls within a policy-approved pointer. */
export function approvalEditsAreAllowed(
  payload: Pick<ApprovalPayload, "args" | "editableFields">,
  edits: readonly ApprovalEdit[],
): boolean {
  return edits.every((edit) => {
    const existing = valueAtPointer(payload.args, edit.pointer);
    let changed: JsonValue | undefined;
    if ("remove" in edit) {
      changed = existing;
    } else if (existing === undefined) {
      changed = edit.value;
    }
    const pointers =
      changed === undefined ? [edit.pointer] : collectLeafPointers(changed, edit.pointer);
    return pointers.every((pointer) =>
      payload.editableFields.some((field) => isInsideEditableField(pointer, field)),
    );
  });
}

function valueAtPointer(root: JsonValue, pointer: JsonPointer): JsonValue | undefined {
  let current = root;
  for (const segment of pointerSegments(pointer)) {
    if (Array.isArray(current)) {
      if (!isArrayIndex(segment)) {
        return undefined;
      }
      const child = current[Number(segment)];
      if (child === undefined) {
        return undefined;
      }
      current = child;
    } else if (isJsonObject(current)) {
      const child = current[segment];
      if (child === undefined) {
        return undefined;
      }
      current = child;
    } else {
      return undefined;
    }
  }
  return current;
}

function collectLeafPointers(value: JsonValue, path: JsonPointer): JsonPointer[] {
  if (isJsonObject(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? [path]
      : entries.flatMap(([key, child]) =>
          collectLeafPointers(
            child,
            JsonPointerSchema.parse(`${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
          ),
        );
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? [path]
      : value.flatMap((child, index) =>
          collectLeafPointers(child, JsonPointerSchema.parse(`${path}/${String(index)}`)),
        );
  }
  return [path];
}

/** Applies validated operations to a detached JSON value, failing closed on invalid paths. */
export function applyApprovalEdits(
  original: JsonValue,
  edits: readonly ApprovalEdit[],
): { readonly success: true; readonly args: JsonValue } | { readonly success: false } {
  let args = copyJson(original);
  try {
    for (const edit of edits) {
      args = setPointer(args, edit.pointer, edit);
    }
    return { success: true, args };
  } catch (error) {
    if (error instanceof InvalidEditPathError) {
      return { success: false };
    }
    throw error;
  }
}

function setPointer(root: JsonValue, pointer: JsonPointer, edit: ApprovalEdit): JsonValue {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    if ("remove" in edit) {
      throw new InvalidEditPathError();
    }
    return copyJson(edit.value);
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const next = segments[index + 1];
    if (Array.isArray(current)) {
      current = applyArrayEdit({ array: current, segment, last, next, edit });
    } else if (isJsonObject(current)) {
      current = applyObjectEdit({ object: current, segment, last, next, edit });
    } else {
      throw new InvalidEditPathError();
    }
  }
  return root;
}

function applyArrayEdit(options: {
  readonly array: JsonValue[];
  readonly segment: string;
  readonly last: boolean;
  readonly next: string | undefined;
  readonly edit: ApprovalEdit;
}): JsonValue {
  const { segment, last, next, edit } = options;
  const target = options.array;
  if (!isArrayIndex(segment)) {
    throw new InvalidEditPathError();
  }
  const index = Number(segment);
  if (
    !Number.isSafeInteger(index) ||
    index > target.length ||
    (index === target.length && "remove" in edit)
  ) {
    throw new InvalidEditPathError();
  }
  if (!last) {
    const child = target[index];
    if (child !== undefined) {
      return child;
    }
    if (index !== target.length || "remove" in edit) {
      throw new InvalidEditPathError();
    }
    const created = createContainer(next);
    target.push(created);
    return created;
  }
  if ("remove" in edit) {
    target.splice(index, 1);
  } else if (index === target.length) {
    target.push(copyJson(edit.value));
  } else {
    target[index] = copyJson(edit.value);
  }
  return target;
}

function applyObjectEdit(options: {
  readonly object: Readonly<Record<string, JsonValue>>;
  readonly segment: string;
  readonly last: boolean;
  readonly next: string | undefined;
  readonly edit: ApprovalEdit;
}): JsonValue {
  const { object, segment, last, next, edit } = options;
  if (last) {
    if ("remove" in edit) {
      if (!Object.hasOwn(object, segment)) {
        throw new InvalidEditPathError();
      }
      Reflect.deleteProperty(object, segment);
    } else {
      Object.defineProperty(object, segment, {
        configurable: true,
        enumerable: true,
        value: copyJson(edit.value),
        writable: true,
      });
    }
    return object;
  }
  const child = object[segment];
  if (child !== undefined) {
    return child;
  }
  if ("remove" in edit) {
    throw new InvalidEditPathError();
  }
  const created = createContainer(next);
  Object.defineProperty(object, segment, {
    configurable: true,
    enumerable: true,
    value: created,
    writable: true,
  });
  return created;
}

function createContainer(next: string | undefined): JsonValue {
  return next !== undefined && isArrayIndex(next) ? [] : {};
}

function isArrayIndex(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/u.test(value);
}
