// SPDX-License-Identifier: Apache-2.0
type WeakObject = Exclude<WeakKey, symbol>;

const sanitized = new WeakSet<WeakObject>();
const sanitizedFields = new WeakMap<WeakObject, Set<PropertyKey>>();

/** Marks an event or object-valued content field as already sanitized. */
export function markSanitized<T>(value: T): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    sanitized.add(value);
  }
  return value;
}

/** Marks a content field on its containing event or call as already sanitized. */
export function markSanitizedField<T>(value: T, field: PropertyKey): T {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    const marked = sanitizedFields.get(value) ?? new Set<PropertyKey>();
    marked.add(field);
    sanitizedFields.set(value, marked);
  }
  return value;
}

/** Checks whether a field on its containing call or result was marked sanitized. */
export function isSanitizedField(value: unknown, field: PropertyKey): boolean {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    sanitizedFields.get(value)?.has(field) === true
  );
}

/** Checks whether a value or one of its fields has already been sanitized. */
export function isMarked(container: unknown, field?: string): boolean {
  if ((typeof container !== "object" || container === null) && typeof container !== "function") {
    return false;
  }
  if (sanitized.has(container)) {
    return true;
  }
  if (field === undefined) {
    return false;
  }
  if (sanitizedFields.get(container)?.has(field) === true) {
    return true;
  }
  const value: unknown = Object.getOwnPropertyDescriptor(container, field)?.value;
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    sanitized.has(value)
  );
}
