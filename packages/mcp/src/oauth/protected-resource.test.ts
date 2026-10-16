// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_CLIENT_CREDENTIALS_EXTENSION,
  resourceAdvertisesClientCredentials,
} from "./protected-resource.js";

const resourceUrl = "https://mcp.example.test/mcp";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resourceAdvertisesClientCredentials", () => {
  it("uses resource_metadata from the challenge when present", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": [
              "Bearer ",
              "resource_",
              "metadata=",
              JSON.stringify("https://auth.example.test/metadata"),
            ].join(""),
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ extensions: { [OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {} } }),
      );

    await expect(resourceAdvertisesClientCredentials(resourceUrl)).resolves.toBe(true);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://auth.example.test/metadata"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("falls back to the well-known URL when the challenge has no resource_metadata", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ extensions: { [OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {} } }),
      );

    await expect(resourceAdvertisesClientCredentials(resourceUrl)).resolves.toBe(true);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://mcp.example.test/.well-known/oauth-protected-resource/mcp"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("fails closed for unsupported metadata URLs and unsuccessful responses", async () => {
    const unsupportedUrlFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": [
            "Bearer ",
            "resource_",
            "metadata=",
            JSON.stringify("file:///etc/passwd"),
          ].join(""),
        },
      }),
    );
    await expect(resourceAdvertisesClientCredentials(resourceUrl)).resolves.toBe(false);
    expect(unsupportedUrlFetch).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(resourceAdvertisesClientCredentials(resourceUrl)).resolves.toBe(false);
  });

  it("fails closed when metadata is malformed or does not advertise the extension", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ extensions: {} }));
    await expect(resourceAdvertisesClientCredentials(resourceUrl)).resolves.toBe(false);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("{"));
    await expect(resourceAdvertisesClientCredentials(resourceUrl)).resolves.toBe(false);
  });
});
