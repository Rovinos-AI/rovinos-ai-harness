// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it } from "vitest";
import { acquireBuildLock, releaseBuildLock } from "./build-images.ts";

afterEach(() => {
  releaseBuildLock();
});

it("lets only one setup hold the image build lock at a time", () => {
  acquireBuildLock();

  expect(() => {
    acquireBuildLock(50, 10);
  }).toThrow("compose_image_build_failed");

  releaseBuildLock();
  expect(() => {
    acquireBuildLock(50, 10);
  }).not.toThrow();
});
