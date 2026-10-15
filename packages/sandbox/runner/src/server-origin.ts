// SPDX-License-Identifier: Apache-2.0
import type { RunnerRequest } from "./request-handler.js";

/** Normalizes an approved HTTP authority, rejecting userinfo and path-bearing values. */
export function authorityFrom(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value.trim() !== value ||
    /[/@?#]/u.test(value)
  ) {
    return undefined;
  }
  try {
    const url = new URL(`http://${value}`);
    if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "") {
      return undefined;
    }
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Checks that an optional Origin matches one of the runner's approved authorities. */
export function validOrigin(
  origin: string | undefined,
  allowedHosts: ReadonlySet<string>,
): boolean {
  if (origin === undefined) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      allowedHosts.has(url.host.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** Checks the request Host against one of the runner's approved authorities. */
export function validHost(request: RunnerRequest, allowedHosts: ReadonlySet<string>): boolean {
  const authority = authorityFrom(request.headers.host);
  return authority !== undefined && allowedHosts.has(authority);
}
