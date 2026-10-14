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

  it("normalizes adjacent text and ignores comments and malformed markup", () => {
    expect(htmlToText("hello<!-- ignored --><b>  world")).toEqual({
      text: "hello world",
      hiddenTextDropped: 0,
    });
  });
});
