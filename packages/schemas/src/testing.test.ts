// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import { FakeClock, SequentialIdGenerator } from "./testing.js";

test("fake clock advances by the requested milliseconds", () => {
  const clock = new FakeClock(1000);
  clock.advance(250);

  expect(clock.now()).toBe(1250);
});

test("sequential ids are unique and 26 characters long", () => {
  const ids = new SequentialIdGenerator();
  const first = ids.next();
  const second = ids.next();

  expect(first).not.toBe(second);
  expect(first).toHaveLength(26);
  expect(second).toHaveLength(26);
});
