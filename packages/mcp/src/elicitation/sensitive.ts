// SPDX-License-Identifier: Apache-2.0
import type { ValidatedInputRequest } from "./validate.js";

const SECRET_FIELD_PATTERN =
  /(?:^|[^\p{L}\p{N}])(?:password|passphrase|token|secret|api key|credential|(?:credit )?card(?: number| security| code)?|cvv|cvc|security code)(?=$|[^\p{L}\p{N}])/u;

function isSensitiveFieldName(value: string): boolean {
  return SECRET_FIELD_PATTERN.test(
    value.toLowerCase().replaceAll(/[_-]+/gu, " ").replaceAll(/\s+/gu, " ").trim(),
  );
}

/** Identifies form requests that must be declined without being shown to a human. */
export function requestsSensitiveFormField(request: ValidatedInputRequest): boolean {
  if (request.mode !== "form" || request.requestedSchema === undefined) {
    return false;
  }
  return Object.entries(request.requestedSchema.properties).some(([name, property]) =>
    [name, property.title, property.description].some(
      (value) => value !== undefined && isSensitiveFieldName(value),
    ),
  );
}
