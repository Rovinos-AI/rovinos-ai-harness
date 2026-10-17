// SPDX-License-Identifier: Apache-2.0
import { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: mocks.spawn };
});

import { openUrlInBrowser } from "./open-browser.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function makeChild() {
  const child = new ChildProcess();
  const unref = vi.spyOn(child, "unref").mockImplementation(() => undefined);
  return { child, unref };
}

afterEach(() => {
  mocks.spawn.mockReset();
  if (platformDescriptor !== undefined) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

describe("openUrlInBrowser", () => {
  it.each([
    ["linux", "xdg-open"],
    ["darwin", "open"],
    ["win32", "explorer.exe"],
  ])("launches the system browser on %s without a shell", async (platform, executable) => {
    setPlatform(platform);
    const { child, unref } = makeChild();
    mocks.spawn.mockReturnValue(child);

    const opening = openUrlInBrowser("https://mcp.example.test/authorize");
    child.emit("spawn");
    await expect(opening).resolves.toBeUndefined();

    expect(mocks.spawn).toHaveBeenCalledWith(executable, ["https://mcp.example.test/authorize"], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalledOnce();
  });

  it("rejects when spawn emits an error or throws synchronously", async () => {
    setPlatform("linux");
    const { child } = makeChild();
    mocks.spawn.mockReturnValueOnce(child);
    const emittedError = openUrlInBrowser("https://mcp.example.test/authorize");
    child.emit("error", new Error("private spawn details"));
    await expect(emittedError).rejects.toThrow("browser_launch_failed");

    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("private spawn details");
    });
    await expect(openUrlInBrowser("https://mcp.example.test/authorize")).rejects.toThrow(
      "browser_launch_failed",
    );
  });
});
