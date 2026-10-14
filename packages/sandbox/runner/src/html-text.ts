// SPDX-License-Identifier: Apache-2.0
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";

const HtmlTextResultSchema = z
  .object({ text: z.string(), hiddenTextDropped: z.number().int().nonnegative() })
  .strict();
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

const excludedElements = new Set(["script", "style", "noscript", "template"]);

function elementIsHidden(element: HtmlElement): boolean {
  const attributes = new Map(element.attrs.map(({ name, value }) => [name, value]));
  const style = attributes.get("style")?.toLowerCase().replaceAll(/\s+/gu, "") ?? "";
  return (
    attributes.has("hidden") ||
    attributes.get("aria-hidden")?.toLowerCase() === "true" ||
    (element.tagName === "input" && attributes.get("type")?.toLowerCase() === "hidden") ||
    /(?:^|;)(?:display:none|visibility:hidden)(?:!important)?(?:;|$)/u.test(style)
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
