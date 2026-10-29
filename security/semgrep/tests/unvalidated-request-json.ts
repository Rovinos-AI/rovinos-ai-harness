// SPDX-License-Identifier: Apache-2.0
// ruleid: harness.request-json-requires-schema
const unsafeBody = JSON.parse(await request.text());
// ok: harness.request-json-requires-schema
const parsedBody = RequestSchema.parse(JSON.parse(await request.text()));
// ruleid: harness.request-json-requires-schema
const runnerBody = JSON.parse(request.body);
// ok: harness.request-json-requires-schema
const parsedRunnerBody = RequestSchema.safeParse(JSON.parse(request.body));
