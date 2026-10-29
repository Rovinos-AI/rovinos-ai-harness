// SPDX-License-Identifier: Apache-2.0
// ruleid: harness.no-insecure-http
const remoteUrl = "http://example.test/data";
// ok: harness.no-insecure-http
const localUrl = "http://127.0.0.1:8080/data";
// ok: harness.no-insecure-http
const localhostUrl = "http://localhost:3000/data";
// ruleid: harness.no-insecure-http
const remoteTemplateUrl = `http://service.example.test/data`;
