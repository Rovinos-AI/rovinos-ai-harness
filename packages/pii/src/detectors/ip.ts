// SPDX-License-Identifier: Apache-2.0
import { isIPv4, isIPv6 } from "node:net";
import { candidateDetector } from "./types.js";

/** IPv4 octets and IPv6 syntax are validated by Node's networking parser. */
export const ipDetector = candidateDetector(
  "ip_address",
  "ip_address",
  /[\da-f:.]+/giu,
  (candidate) => {
    const value = candidate.endsWith(".") ? candidate.slice(0, -1) : candidate;
    return value.length <= 45 && (isIPv4(value) || isIPv6(value)) ? value : false;
  },
);
