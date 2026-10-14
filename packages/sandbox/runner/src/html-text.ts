// SPDX-License-Identifier: Apache-2.0
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";

const HtmlTextResultSchema = z
  .object({ text: z.string(), hiddenTextDropped: z.number().int().nonnegative() })
  .strict();
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

const excludedElements = new Set(["script", "style", "noscript", "template"]);

type CssQuote = "'" | '"';

function isCssQuote(character: string): character is CssQuote {
  return character === "'" || character === '"';
}

function stripCssComments(style: string): string {
  let normalized = "";
  let quote: CssQuote | undefined;
  let escaped = false;
  for (let index = 0; index < style.length; index += 1) {
    const character = style[index] ?? "";
    const next = style[index + 1];
    if (quote !== undefined) {
      normalized += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (isCssQuote(character)) {
      quote = character;
      normalized += character;
    } else if (character === "/" && next === "*") {
      const commentEnd = style.indexOf("*/", index + 2);
      if (commentEnd < 0) {
        break;
      }
      index = commentEnd + 1;
    } else {
      normalized += character;
    }
  }
  return normalized;
}

function splitCss(value: string, separator: string): string[] {
  const parts: string[] = [];
  let part = "";
  let quote: CssQuote | undefined;
  let escaped = false;
  for (const character of value) {
    if (quote !== undefined) {
      part += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (isCssQuote(character)) {
      quote = character;
      part += character;
    } else if (character === separator) {
      parts.push(part);
      part = "";
    } else {
      part += character;
    }
  }
  parts.push(part);
  return parts;
}

function isHiddenCssDeclaration(declaration: string): boolean {
  const [rawProperty, ...rawValue] = splitCss(declaration, ":");
  if (rawProperty === undefined || rawValue.length === 0) {
    return false;
  }
  const property = rawProperty.trim().toLowerCase();
  const value = rawValue
    .join(":")
    .trim()
    .toLowerCase()
    .replaceAll(/\s*!\s*important\s*$/gu, "");
  return (
    (property === "display" && value === "none") ||
    (property === "visibility" && value === "hidden") ||
    (property === "opacity" && /^(?:0+(?:\.0*)?|\.0+)$/u.test(value))
  );
}

function cssHidesElement(style: string | undefined): boolean {
  return style !== undefined && splitCss(stripCssComments(style), ";").some(isHiddenCssDeclaration);
}

function elementIsHidden(element: HtmlElement): boolean {
  const attributes = new Map(element.attrs.map(({ name, value }) => [name, value]));
  return (
    attributes.has("hidden") ||
    attributes.get("aria-hidden")?.trim().toLowerCase() === "true" ||
    (element.tagName === "input" && attributes.get("type")?.toLowerCase() === "hidden") ||
    cssHidesElement(attributes.get("style"))
  );
}

function visit(node: HtmlNode, hidden: boolean, output: string[]): number {
  if (node.nodeName === "#text" && "value" in node) {
    if (hidden) {
      return node.value.length;
    }
    output.push(node.value);
    return 0;
  }
  if (
    node.nodeName === "#comment" ||
    node.nodeName === "#documentType" ||
    !("childNodes" in node)
  ) {
    return 0;
  }
  const element = "tagName" in node ? node : undefined;
  if (element !== undefined && excludedElements.has(element.tagName)) {
    return 0;
  }
  const childHidden = hidden || (element !== undefined && elementIsHidden(element));
  return node.childNodes.reduce((count, child) => count + visit(child, childHidden, output), 0);
}

/** Converts HTML to visible text while dropping scripts, styles, and hidden content. */
export function htmlToText(html: string): z.infer<typeof HtmlTextResultSchema> {
  const text: string[] = [];
  const hiddenTextDropped = visit(parseFragment(html), false, text);
  return HtmlTextResultSchema.parse({
    text: text.join(" ").replaceAll(/\s+/gu, " ").trim(),
    hiddenTextDropped,
  });
}
