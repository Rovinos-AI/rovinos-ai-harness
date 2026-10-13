# Collector network access

Docker Compose attaches the harness and collector to the internal network. Only the collector also joins the egress network; the harness and sidecars cannot route directly outside the internal network. The collector's own egress is reserved for the exporter endpoints enabled by its profile, not general-purpose traffic.

`infra/k8s/networkpolicy.example.yaml` is an example Kubernetes policy, not a supported deployment. It denies egress by default in the namespace and permits harness pods to reach the collector on OTLP ports 4317 and 4318 and pods explicitly labeled as approved harness sidecars. Adapt the pod selectors to the deployment and ensure no other NetworkPolicy grants the harness additional egress. The collector needs a separate, deployment-specific egress allowance for the configured exporter endpoints; standard Kubernetes NetworkPolicy does not express DNS names.
