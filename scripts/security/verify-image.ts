// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

const imageReferenceSchema = z
  .string()
  .regex(/^ghcr\.io\/rovinos-ai\/(harness|harness-sandbox)@sha256:[0-9a-f]{64}$/u);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const manifestDescriptorSchema = z.object({
  digest: digestSchema,
  annotations: z.record(z.string(), z.string()).optional(),
});
const imageIndexSchema = z.object({
  manifests: z.array(manifestDescriptorSchema).min(1),
});
const attestationManifestSchema = z.object({
  layers: z.array(
    z.object({
      digest: digestSchema,
      mediaType: z.string(),
      annotations: z.record(z.string(), z.string()).optional(),
    }),
  ),
});
const tokenResponseSchema = z.object({
  token: z.string().regex(/^[\w.+/=-]+$/u),
});
const spdxStatementSchema = z.object({
  _type: z.enum(["https://in-toto.io/Statement/v0.1", "https://in-toto.io/Statement/v1"]),
  predicateType: z.literal("https://spdx.dev/Document"),
  subject: z.array(
    z.object({
      digest: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/u) }),
    }),
  ),
  predicate: z.object({ spdxVersion: z.string().min(1) }),
});
const verificationErrorCodeSchema = z.enum([
  "image_reference_invalid",
  "verification_tool_missing",
  "image_signature_invalid",
  "image_attestation_missing",
  "image_attestation_invalid",
]);
const maxRegistryResponseBytes = 16 * 1024 * 1024;
const oidcIssuer = "https://token.actions.githubusercontent.com";
const releaseIdentity =
  "^https://github\\.com/Rovinos-AI/rovinos-ai-harness/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$";

type VerificationErrorCode = z.infer<typeof verificationErrorCodeSchema>;

class ImageVerificationError extends Error {
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode) {
    super(code);
    this.name = "ImageVerificationError";
    this.code = verificationErrorCodeSchema.parse(code);
  }
}

function runTool(
  command: string,
  args: readonly string[],
): { stdout: string; status: number | null } {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: maxRegistryResponseBytes * 2,
  });
  if (result.error !== undefined) {
    throw new ImageVerificationError("verification_tool_missing");
  }
  return { stdout: result.stdout, status: result.status };
}

function parseRegistryJson<Schema extends z.ZodType>(
  schema: Schema,
  output: string,
  errorCode: VerificationErrorCode,
): z.infer<Schema> {
  try {
    return parseJson(schema, output, { maxBytes: maxRegistryResponseBytes });
  } catch {
    throw new ImageVerificationError(errorCode);
  }
}

function registryOutput(
  command: string,
  args: readonly string[],
  errorCode: VerificationErrorCode,
): string {
  const result = runTool(command, args);
  if (result.status !== 0) {
    throw new ImageVerificationError(errorCode);
  }
  return result.stdout;
}

function verifySignature(imageReference: string): void {
  const signature = runTool("cosign", [
    "verify",
    "--certificate-identity-regexp",
    releaseIdentity,
    "--certificate-oidc-issuer",
    oidcIssuer,
    imageReference,
  ]);
  if (signature.status !== 0) {
    throw new ImageVerificationError("image_signature_invalid");
  }
}

function readImageIndex(imageReference: string): z.infer<typeof imageIndexSchema> {
  const imageIndexText = registryOutput(
    "docker",
    ["buildx", "imagetools", "inspect", "--raw", imageReference],
    "image_attestation_missing",
  );
  return parseRegistryJson(imageIndexSchema, imageIndexText, "image_attestation_missing");
}

function readAttestationManifest(
  image: string,
  attestationDigest: string,
): z.infer<typeof attestationManifestSchema> {
  const manifestText = registryOutput(
    "docker",
    ["buildx", "imagetools", "inspect", "--raw", `${image}@${attestationDigest}`],
    "image_attestation_missing",
  );
  return parseRegistryJson(attestationManifestSchema, manifestText, "image_attestation_missing");
}

function findImageAttestation(imageReference: string): {
  repository: string;
  imageManifestDigest: string;
  sbomBlobDigest: string;
} {
  const image = imageReference.slice(0, imageReference.lastIndexOf("@"));
  const repository = image.slice("ghcr.io/".length);
  const imageIndex = readImageIndex(imageReference);
  const imageManifestDigest = imageIndex.manifests.find(
    (manifest) => manifest.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest",
  )?.digest;
  if (imageManifestDigest === undefined) {
    throw new ImageVerificationError("image_attestation_missing");
  }

  const attestationDigest = imageIndex.manifests.find(
    (manifest) =>
      manifest.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" &&
      manifest.annotations["vnd.docker.reference.digest"] === imageManifestDigest,
  )?.digest;
  if (attestationDigest === undefined) {
    throw new ImageVerificationError("image_attestation_missing");
  }

  const attestationManifest = readAttestationManifest(image, attestationDigest);
  const sbomBlobDigest = attestationManifest.layers.find(
    (layer) =>
      layer.mediaType === "application/vnd.in-toto+json" &&
      layer.annotations?.["in-toto.io/predicate-type"] === "https://spdx.dev/Document",
  )?.digest;
  if (sbomBlobDigest === undefined) {
    throw new ImageVerificationError("image_attestation_missing");
  }
  return { repository, imageManifestDigest, sbomBlobDigest };
}

function fetchRegistryToken(repository: string): string {
  const tokenText = registryOutput(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-time",
      "60",
      "--get",
      "--data-urlencode",
      `scope=repository:${repository}:pull`,
      "https://ghcr.io/token",
    ],
    "image_attestation_missing",
  );
  return parseRegistryJson(tokenResponseSchema, tokenText, "image_attestation_missing").token;
}

function fetchSbom(repository: string, digest: string, token: string): string {
  const authorizationHeader = ["Authorization:", "Bearer", token].join(" ");
  return registryOutput(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--connect-timeout",
      "10",
      "--max-time",
      "60",
      "--header",
      authorizationHeader,
      "--output",
      "-",
      `https://ghcr.io/v2/${repository}/blobs/${digest}`,
    ],
    "image_attestation_missing",
  );
}

function verifySbomPayload(
  sbomText: string,
  blobDigest: string,
  imageManifestDigest: string,
): void {
  const actualSbomDigest = `sha256:${createHash("sha256").update(sbomText).digest("hex")}`;
  if (actualSbomDigest !== blobDigest) {
    throw new ImageVerificationError("image_attestation_invalid");
  }

  const statement = parseRegistryJson(spdxStatementSchema, sbomText, "image_attestation_invalid");
  const expectedDigest = imageManifestDigest.slice("sha256:".length);
  if (!statement.subject.some((subject) => subject.digest.sha256 === expectedDigest)) {
    throw new ImageVerificationError("image_attestation_invalid");
  }
}

function verifyImage(imageReference: string): void {
  verifySignature(imageReference);
  const attestation = findImageAttestation(imageReference);
  const registryToken = fetchRegistryToken(attestation.repository);
  const sbomText = fetchSbom(attestation.repository, attestation.sbomBlobDigest, registryToken);
  verifySbomPayload(sbomText, attestation.sbomBlobDigest, attestation.imageManifestDigest);
}

function main(): void {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--verify") {
      throw new ImageVerificationError("image_reference_invalid");
    }
    const imageReference = imageReferenceSchema.safeParse(args[1]);
    if (!imageReference.success) {
      throw new ImageVerificationError("image_reference_invalid");
    }
    verifyImage(imageReference.data);
    process.stdout.write("Verified image signature and SBOM attestation.\n");
  } catch (error) {
    const code = error instanceof ImageVerificationError ? error.code : "verification_tool_missing";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("/scripts/security/verify-image.ts") === true) {
  main();
}
