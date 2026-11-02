// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifyScript = join(root, "scripts/security/verify-image.sh");
const imageDigest = `sha256:${"a".repeat(64)}`;
const imageReference = `ghcr.io/rovinos-ai/harness@${imageDigest}`;
const imageManifestDigest = `sha256:${"c".repeat(64)}`;
const temporaryDirectories: string[] = [];

function createCommandMocks(
  input: {
    cosignStatus?: number;
    imageIndex?: string;
    sbomPayload?: string;
  } = {},
): { env: NodeJS.ProcessEnv; commandLog: string } {
  const directory = mkdtempSync(join(tmpdir(), "verify-image-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const commandLog = join(directory, "commands.log");
  writeFileSync(commandLog, "");
  const sbomPayload =
    input.sbomPayload ??
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://spdx.dev/Document",
      subject: [{ digest: { sha256: imageManifestDigest.slice("sha256:".length) } }],
      predicate: { spdxVersion: "SPDX-2.3" },
    });
  const sbomBlobDigest = `sha256:${createHash("sha256").update(sbomPayload).digest("hex")}`;
  const imageIndex =
    input.imageIndex ??
    JSON.stringify({
      manifests: [
        {
          digest: imageManifestDigest,
          platform: { architecture: "amd64", os: "linux" },
        },
        {
          digest: `sha256:${"b".repeat(64)}`,
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": imageManifestDigest,
          },
        },
      ],
    });
  const attestationManifest = JSON.stringify({
    layers: [
      {
        digest: sbomBlobDigest,
        mediaType: "application/vnd.in-toto+json",
        annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
      },
    ],
  });
  const writeExecutable = (name: string, body: string) => {
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\n# SPDX-License-Identifier: Apache-2.0\nset -euo pipefail\n${body}\n`,
      { mode: 0o755 },
    );
  };

  writeExecutable(
    "cosign",
    `printf 'cosign %s\\n' "$*" >> "$COMMAND_LOG"\nexit "\${COSIGN_STATUS:-0}"`,
  );
  writeExecutable(
    "docker",
    [
      `printf 'docker %s\\n' "$*" >> "$COMMAND_LOG"`,
      `if [ "$5" = "${imageReference}" ]; then`,
      `  printf '%s\\n' '${imageIndex}'`,
      "else",
      `  printf '%s\\n' '${attestationManifest}'`,
      "fi",
    ].join("\n"),
  );
  writeExecutable(
    "curl",
    [
      `printf 'curl requested\\n' >> "$COMMAND_LOG"`,
      `if [[ "$*" == *"https://ghcr.io/token"* ]]; then`,
      `  printf '%s\\n' '{"token":"synthetic-read-token"}'`,
      "else",
      '  output=""',
      '  while [ "$#" -gt 0 ]; do',
      '    if [ "$1" = "--output" ]; then shift; output="$1"; fi',
      "    shift",
      "  done",
      '  if [ "$output" = "-" ]; then printf "%s" "$SBOM_PAYLOAD"; else printf "%s" "$SBOM_PAYLOAD" > "$output"; fi',
      "fi",
    ].join("\n"),
  );

  return {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      COMMAND_LOG: commandLog,
      COSIGN_STATUS: String(input.cosignStatus ?? 0),
      SBOM_PAYLOAD: sbomPayload,
    },
    commandLog,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("verify-image.sh", () => {
  it("rejects tags and malformed references before invoking verification tools", () => {
    const mocks = createCommandMocks();
    const result = spawnSync(
      "bash",
      [verifyScript, "--verify", "ghcr.io/rovinos-ai/harness:v0.2.0"],
      {
        encoding: "utf8",
        env: mocks.env,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("image_reference_invalid");
    expect(readFileSync(mocks.commandLog, "utf8")).toBe("");
  });

  it("verifies the release identity and the digest-bound SPDX payload", () => {
    const mocks = createCommandMocks();
    const result = spawnSync("bash", [verifyScript, "--verify", imageReference], {
      encoding: "utf8",
      env: mocks.env,
    });
    const commands = readFileSync(mocks.commandLog, "utf8");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verified image signature and SBOM attestation.");
    expect(commands).toContain("cosign verify --certificate-identity-regexp");
    expect(commands).toContain("https://token.actions.githubusercontent.com");
    expect(commands).toContain(`docker buildx imagetools inspect --raw ${imageReference}`);
    expect(commands).toContain("curl requested");
  });

  it("fails when the signature has the wrong keyless identity", () => {
    const mocks = createCommandMocks({ cosignStatus: 1 });
    const result = spawnSync("bash", [verifyScript, "--verify", imageReference], {
      encoding: "utf8",
      env: mocks.env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("image_signature_invalid");
    expect(readFileSync(mocks.commandLog, "utf8")).not.toContain("docker ");
    expect(readFileSync(mocks.commandLog, "utf8")).not.toContain("curl ");
  });

  it("fails when the signed image index has no attached SBOM attestation", () => {
    const mocks = createCommandMocks({ imageIndex: '{"manifests":[]}' });
    const result = spawnSync("bash", [verifyScript, "--verify", imageReference], {
      encoding: "utf8",
      env: mocks.env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("image_attestation_missing");
  });

  it("fails when the referenced SBOM payload does not name the image digest", () => {
    const wrongSubject = JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://spdx.dev/Document",
      subject: [{ digest: { sha256: "f".repeat(64) } }],
      predicate: { spdxVersion: "SPDX-2.3" },
    });
    const mocks = createCommandMocks({ sbomPayload: wrongSubject });
    const result = spawnSync("bash", [verifyScript, "--verify", imageReference], {
      encoding: "utf8",
      env: mocks.env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("image_attestation_invalid");
  });
});
