// SPDX-License-Identifier: Apache-2.0
// Shared by the Compose test and unit tests so the injected JavaScript has the same deadlines.
export const probeHelpers = `
const http = require("node:http");
const net = require("node:net");
const probeTimeout = { status: -1, body: "probe_timeout" };
const viaProxy = (url, proxy, timeoutMs = 2000) => new Promise((resolve) => {
  let request;
  let response;
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    resolve(result);
    response?.destroy();
    request?.destroy();
  };
  const timeout = setTimeout(() => finish(probeTimeout), timeoutMs);
  request = http.get({ hostname: proxy.hostname, port: Number(proxy.port), path: url }, (incoming) => {
    if (done) { incoming.destroy(); return; }
    response = incoming;
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => finish({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    response.on("aborted", () => finish({ status: 0, body: "response_aborted" }));
    response.on("error", () => finish({ status: 0, body: "response_failed" }));
    response.on("close", () => finish({ status: 0, body: "response_closed" }));
  });
  request.on("error", (error) => finish({ status: 0, body: error.code || "request_failed" }));
});
const direct = (host, port, timeoutMs = 2000) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    resolve(result);
    socket.destroy();
  };
  // The independent deadline also bounds DNS/connecting, where inactivity timeouts may not fire.
  const timeout = setTimeout(() => finish(probeTimeout), timeoutMs);
  socket.setTimeout(1000, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  socket.once("close", () => finish(false));
});
const runProbes = (probes, proxyEnvPresent, watchdogMs = 10000) => {
  const pending = new Set(Object.keys(probes));
  const results = { proxyEnvPresent };
  let written = false;
  const writeResults = () => {
    if (written) return;
    written = true;
    clearTimeout(watchdog);
    // Flush the small diagnostic synchronously so an async write callback cannot delay exit.
    require("node:fs").writeSync(1, JSON.stringify({ ...results, pending: [...pending] }));
    process.exit(0);
  };
  const watchdog = setTimeout(writeResults, watchdogMs);
  for (const [name, probe] of Object.entries(probes)) {
    Promise.resolve().then(probe).catch(() => ({ status: 0, body: "probe_failed" })).then((result) => {
      results[name] = result;
      pending.delete(name);
      if (pending.size === 0) writeResults();
    });
  }
};
`;

/**
 * Builds the egress probe scenario for a suite's isolated fixture endpoint.
 *
 * @param probeIp - Address used for the direct-route check.
 * @param probeHost - DNS alias used for the allowlisted HTTP request.
 */
export function egressProbeScript(
  probeIp = "198.51.100.3",
  probeHost = "egress-probe.test",
): string {
  return `${probeHelpers}
const proxyEnvPresent = typeof process.env.HTTP_PROXY === "string" && process.env.HTTP_PROXY.length > 0;
const proxy = new URL(process.env.HTTP_PROXY ?? "http://invalid");
runProbes({
  allowed: () => viaProxy(${JSON.stringify(`http://${probeHost}:8080/`)}, proxy),
  denied: () => viaProxy("http://denied.example.test/", proxy),
  metadata: () => viaProxy("http://metadata.example.test/", proxy),
  directProbe: () => direct(${JSON.stringify(probeIp)}, 8080),
  directMetadata: () => direct("169.254.169.254", 80),
}, proxyEnvPresent);
`;
}
