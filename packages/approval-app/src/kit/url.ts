// SPDX-License-Identifier: Apache-2.0
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

/** Displays a URL as text with its registrable domain highlighted; no link is created. */
export function createUrlDisplay(document: Document, value: string): HTMLElement {
  const display = element(document, "span");
  try {
    const parsed = new URL(value);
    const schemeEnd = value.indexOf("://");
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || schemeEnd < 0) {
      display.textContent = value;
      return display;
    }
    const authorityStart = schemeEnd + 3;
    const authority = value.slice(authorityStart).split(/[/?#]/u, 1)[0] ?? "";
    const hostStartInAuthority = authority.lastIndexOf("@") + 1;
    const domainName = getRegistrableDomain(parsed.hostname);
    const domainOffset = authority
      .slice(hostStartInAuthority)
      .toLowerCase()
      .lastIndexOf(domainName.toLowerCase());
    if (domainOffset < 0) {
      display.textContent = value;
      return display;
    }
    const domainStart = authorityStart + hostStartInAuthority + domainOffset;
    const domainEnd = domainStart + domainName.length;
    const domain = element(document, "strong", domainName);
    display.append(
      element(document, "span", value.slice(0, domainStart)),
      domain,
      element(document, "span", value.slice(domainEnd)),
    );
  } catch {
    display.textContent = value;
  }
  return display;
}

/** Returns the registrable hostname using common multi-label public suffixes. */
export function getRegistrableDomain(hostname: string): string {
  const labels = hostname.split(".");
  const suffix = labels.slice(-2).join(".");
  const suffixDepth = new Set([
    "co.uk",
    "org.uk",
    "com.au",
    "net.au",
    "co.nz",
    "co.jp",
    "com.br",
    "com.mx",
    "co.in",
    "co.kr",
    "com.sg",
  ]).has(suffix)
    ? 2
    : 1;
  return labels.length > suffixDepth ? labels.slice(-(suffixDepth + 1)).join(".") : hostname;
}
