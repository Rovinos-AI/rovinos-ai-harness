# Sandbox egress

The sandbox runner has no external network route by default. Its default Compose attachment is the internal `sandbox` network used to reach the harness. The `sandbox-egress` network is internal as well; it connects the runner to the egress proxy only. The proxy alone also joins `egress`, which has an external route. The proxy is in the `sandbox-egress` Compose profile and is not started by the default sandbox profile.

## Configure an allowlist

Use exact host names and explicit ports in the harness configuration:

```yaml
sandbox:
  egress:
    allow:
      - host: api.example.com
        ports: [443]
```

Run the sandbox Compose wrapper from the repository root. It loads the harness config, serializes `sandbox.egress.allow` into `SANDBOX_EGRESS_ALLOW`, and selects the egress overlay only when the list is non-empty:

```sh
SANDBOX_RUNNER_TOKEN="$(cat /secure/sandbox-runner-token)" \
  yarn compose:sandbox up --detach --build sandbox-runner sandbox-egress-proxy
```

With an empty or absent allowlist, the wrapper uses only the base Compose file and `sandbox` profile. The runner starts with no proxy variables and the proxy service is not started. With a non-empty allowlist, the wrapper passes it to Compose and enables the `sandbox-egress` profile. The proxy validates its configuration at startup and exits if the list is invalid.

The runner injects both uppercase and lowercase HTTP/HTTPS proxy variables into each command and removes `NO_PROXY` and `no_proxy`, so commands cannot exempt destinations from proxy enforcement.

The proxy supports HTTP forwarding and HTTP CONNECT. It matches normalized host names and ports exactly, resolves the requested destination once, rejects the entire DNS answer set if any address is loopback, link-local/metadata, private or shared (`100.64.0.0/10`), in `192.0.0.0/24` or `198.18.0.0/15`, IPv6 unique-local/site-local/discard-only, Teredo, or multicast, and connects to the first validated resolved IP. Embedded IPv4 addresses in mapped IPv6, NAT64, and 6to4 addresses receive the same checks. Public IP literals are accepted only when explicitly listed. Wildcard and private IP-literal entries fail startup validation.

Proxy output contains only `egress_allowed` / `egress_denied` counters and bounded reason codes. It does not emit hostnames, request paths, or URLs. The allowlist and proxy route are the egress boundary: a child that ignores proxy variables still has no direct external route.
