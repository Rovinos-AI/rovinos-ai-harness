// SPDX-License-Identifier: Apache-2.0
import { candidateDetector, stripTrailingPeriods } from "./types.js";
import type { Detector } from "./types.js";

const keys = candidateDetector("secrets", "api_key", /[\w.-]+/gu, (candidate) => {
  const value = stripTrailingPeriods(candidate);
  if (/^(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36})$/u.test(value)) {
    return value;
  }
  const segments = value.split(".");
  return segments.length === 3 && segments.every((segment) => /^[\w-]+$/u.test(segment))
    ? value
    : false;
});

const privateKeys = candidateDetector(
  "secrets",
  "api_key",
  /-----BEGIN (?:[A-Z0-9]{1,16} )?PRIVATE KEY-----/gu,
  () => true,
);

/** AWS/GitHub keys, JWT-shaped strings, and private-key opening markers. */
export const secretsDetector: Detector = {
  id: "secrets",
  entityTypes: ["api_key"],
  detect: (text) =>
    [...keys.detect(text), ...privateKeys.detect(text)].sort((a, b) => a.start - b.start),
};

/** URL userinfo with both a username and password; paths are excluded. */
export const urlCredentialsDetector = candidateDetector(
  "url_credentials",
  "url_credentials",
  /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#"'<>;,]+/giu,
  (value) => {
    const userinfo = value.slice(value.indexOf("://") + 3);
    return /^[^:@]{1,256}:[^@]{1,256}@[^@]{1,253}$/u.test(userinfo);
  },
);
