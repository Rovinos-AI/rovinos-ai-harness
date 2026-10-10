// SPDX-License-Identifier: Apache-2.0
import { candidateDetector } from "./types.js";

function validEmail(value: string): boolean {
  if (value.length > 254) {
    return false;
  }
  const parts = value.split("@");
  const [local, domain] = parts;
  if (
    parts.length !== 2 ||
    local === undefined ||
    domain === undefined ||
    !/^[\w!#$%&'*+/=?^`{|}~.-]{1,64}$/iu.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    return false;
  }
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))
  );
}

/** Simplified unquoted RFC 5322 addresses with a dotted domain. */
export const emailDetector = candidateDetector(
  "email",
  "email",
  /[\w!#$%&'*+/=?^`{|}~.@-]+/giu,
  (candidate) => {
    let end = candidate.length;
    while (candidate[end - 1] === ".") {
      end--;
    }
    const value = candidate.slice(0, end);
    return validEmail(value) ? value : false;
  },
);
