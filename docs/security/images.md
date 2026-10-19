# Container images

The harness and sandbox runner images use pinned base-image digests listed in
[`infra/images.lock`](../../infra/images.lock). Dependabot checks Dockerfile
references weekly; review its digest updates and update the lock file in the
same change.

Build the images from the repository root:

```sh
docker build --build-arg REVISION="$(git rev-parse HEAD)" -t harness:local -f Dockerfile .
docker build --build-arg REVISION="$(git rev-parse HEAD)" -t harness-sandbox:local -f Dockerfile.sandbox .
```

To use a different base image, update the corresponding `FROM` references in
both Dockerfiles and `infra/images.lock` with the registry digest for the chosen
tag. Review the image's runtime contents, verify the image-hardening integration
tests, then commit the pinned reference and lock update together. The sandbox
runner intentionally omits Docker CLI, compilers, and optional toolchains; build
a separate derived image when a workload needs extra tools.

Both runtime images run as numeric non-root users, remove package-manager
executables and metadata, and strip setuid/setgid bits. The hardening tests also
exercise these images with dropped capabilities and a read-only root filesystem.
Those checks assume a trusted container runtime and host kernel; they do not
address kernel vulnerabilities or malicious host configuration.
