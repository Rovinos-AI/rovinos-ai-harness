// SPDX-License-Identifier: Apache-2.0
// ruleid: harness.fetch-requires-signal
fetch("https://example.test/data");
// ok: harness.fetch-requires-signal
fetch("https://example.test/data", { signal: controller.signal });
// ruleid: harness.fetch-requires-signal
fetch("https://example.test/data", { method: "GET" });
// ok: harness.fetch-requires-signal
fetch("https://example.test/data", {
  ...(signal === undefined ? {} : { signal }),
});
