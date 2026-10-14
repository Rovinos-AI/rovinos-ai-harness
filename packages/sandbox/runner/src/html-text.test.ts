// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-text.js";

describe("htmlToText", () => {
  it("extracts visible text, decodes entities, and skips script/style content", () => {
    expect(
      htmlToText("<p>Hello&nbsp;world</p><script>secret()</script><style>.x{}</style>"),
    ).toEqual({
      text: "Hello world",
      hiddenTextDropped: 0,
    });
  });

  it("drops and counts text hidden by attributes, accessibility state, or CSS", () => {
    expect(
      htmlToText(
        '<p hidden>one</p><div aria-hidden="TRUE">two<strong> nested</strong></div><span style="display: none">three</span><input type="hidden">shown',
      ),
    ).toEqual({ text: "shown", hiddenTextDropped: 18 });
  });

  it.each([
    ['<span style="display:/**/none">hidden-canary</span>', "display:none"],
    ['<span style="display : none ! important">hidden</span>', "display:none !important"],
    ['<span style="visibility: /**/ hidden">hidden</span>', "visibility:hidden"],
    ['<span style="opacity : /**/ 0.0 !important">hidden</span>', "opacity:0"],
    ['<span hidden="hidden">hidden</span>', "hidden attribute"],
    ['<span aria-hidden=" TRUE ">hidden</span>', "aria-hidden"],
  ])("drops hidden text from %s", (html) => {
    const result = htmlToText(html);
    expect(result).toEqual({
      text: "",
      hiddenTextDropped: html.includes("hidden-canary") ? 13 : 6,
    });
  });

  it("does not retain CSS-comment-hidden canary text", () => {
    const result = htmlToText('<span style="display:/**/none">hidden-canary</span><p>visible</p>');
    expect(result).toEqual({ text: "visible", hiddenTextDropped: "hidden-canary".length });
    expect(JSON.stringify(result)).not.toContain("hidden-canary");
  });

  it("normalizes adjacent text and ignores comments and malformed markup", () => {
    expect(htmlToText("hello<!-- ignored --><b>  world")).toEqual({
      text: "hello world",
      hiddenTextDropped: 0,
    });
    expect(
      htmlToText("<span style='content:\"display:none;/**/\"; color:red'>visible</span>"),
    ).toEqual({ text: "visible", hiddenTextDropped: 0 });
  });
});
