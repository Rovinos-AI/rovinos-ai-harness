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

Compose deployment passes the same `allow` entries as JSON in `SANDBOX_EGRESS_ALLOW`. Enable both the egress overlay and profile:

```sh
SANDBOX_RUNNER_TOKEN="$(cat /secure/sandbox-runner-token)" \
SANDBOX_EGRESS_ALLOW='[{"host":"api.example.com","ports":[443]}]' \
  docker compose --env-file infra/collector/VERSION \
  --file infra/compose/docker-compose.yml \
  --file infra/compose/docker-compose.egress.yml \
  --profile sandbox --profile sandbox-egress \
  up --detach --build sandbox-runner sandbox-egress-proxy
```

Do not enable the egress profile with an empty allowlist. The proxy validates its configuration at startup and exits if the list is invalid or empty. The runner starts with no proxy variables in the default profile; in the egress overlay, the runner injects the proxy URL into `HTTP_PROXY` and `HTTPS_PROXY` for each command. Commands cannot set their own proxy or bypass variables.

The proxy supports HTTP forwarding and HTTP CONNECT. It matches normalized host names and ports exactly, resolves the requested destination once, rejects the entire DNS answer set if any address is loopback, link-local (including `169.254.169.254`), private, IPv6 unique-local, or multicast, and connects to the first validated resolved IP. Public IP literals are accepted only when explicitly listed. Wildcard and private IP-literal entries fail startup validation.

Proxy output contains only `egress_allowed` / `egress_denied` counters and bounded reason codes. It does not emit hostnames, request paths, or URLs. The allowlist and proxy route are the egress boundary: a child that ignores proxy variables still has no direct external route.
