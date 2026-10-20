// SPDX-License-Identifier: Apache-2.0
import type { ValidatedInputRequest } from "./validate.js";

const SECRET_FIELD_PATTERN =
  /password|passphrase|token|secret|api[\s_-]?key|credential|credit[\s_-]?card|card[\s_-]?(?:number|security|code)?|cvv|cvc|security[\s_-]?code/iu;

/** Identifies form requests that must be declined without being shown to a human. */
export function requestsSensitiveFormField(request: ValidatedInputRequest): boolean {
  if (request.mode !== "form" || request.requestedSchema === undefined) {
    return false;
  }
  return Object.entries(request.requestedSchema.properties).some(([name, property]) =>
    [name, property.title, property.description].some(
      (value) => value !== undefined && SECRET_FIELD_PATTERN.test(value),
    ),
  );
}
