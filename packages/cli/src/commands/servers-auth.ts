// SPDX-License-Identifier: Apache-2.0
import { CompositeSecretResolver, type HarnessConfig } from "@harness/config";
import {
  McpAuthRequiredError,
  OAuthTokenStore,
  OAuthTokenStoreError,
  startMcpOAuthLogin,
} from "@harness/mcp";
import { openUrlInBrowser } from "@harness/sandbox";
import { Code, HarnessError } from "@harness/schemas";
import type { KeyProvider } from "@harness/schemas";
import { LocalKeyProvider } from "@harness/vault";
import type { Command } from "commander";
import { join } from "node:path";
import { z } from "zod";
import type { CliContext } from "../command.js";
import type { Output } from "../output.js";

const ServerAuthCommandResultSchema = z
  .object({
    status: z.enum(["authorization_required", "authorized", "logged_out"]),
    authorizationUrl: z.url().optional(),
  })
  .strict();

class ServersCommandError extends HarnessError {
  override readonly code:
    | "mcp_server_not_found"
    | "mcp_auth_required"
    | "key_config_required"
    | "server_browser_open_failed";

  constructor(
    code:
      | "mcp_server_not_found"
      | "mcp_auth_required"
      | "key_config_required"
      | "server_browser_open_failed",
  ) {
    super(code);
    this.code = code;
  }
}

/** Creates the key provider used by the persistent OAuth credential store. */
export function createLoginKeys(config: HarnessConfig, context: CliContext): LocalKeyProvider {
  if (config.keys === undefined) {
    throw new ServersCommandError("key_config_required");
  }
  const resolver = context.secretResolver ?? new CompositeSecretResolver();
  return new LocalKeyProvider({
    config: config.keys,
    secretResolver: { resolve: (reference) => resolver.resolve(reference) },
    env: process.env,
    onWarning: () => undefined,
  });
}

function printAuthResult(
  output: Output,
  program: Command,
  result: z.infer<typeof ServerAuthCommandResultSchema>,
): void {
  if (program.optsWithGlobals().json === true) {
    output.json(ServerAuthCommandResultSchema, result);
    return;
  }
  output.print(`${result.authorizationUrl ?? result.status}\n`);
}

interface LoginDependencies {
  readonly program: Command;
  readonly context: CliContext;
  readonly openBrowser: ((url: string) => Promise<void>) | undefined;
}

async function runServersLogin(
  serverId: string,
  options: { readonly open?: boolean },
  dependencies: LoginDependencies,
): Promise<void> {
  const { program, context, openBrowser } = dependencies;
  const config = await context.loadConfig();
  const server = config.servers.find(({ id }) => id === serverId);
  if (server === undefined) {
    throw new ServersCommandError("mcp_server_not_found");
  }
  if (server.transport.kind !== "http" || server.transport.auth?.grant !== "authorization_code") {
    throw new McpAuthRequiredError();
  }

  const core = await import("@harness/core");
  const keys = createLoginKeys(config, context);
  let store: OAuthTokenStore | undefined;
  let session: Awaited<ReturnType<typeof startMcpOAuthLogin>> | undefined;
  try {
    store = await OAuthTokenStore.open(
      join(core.resolveDataDir(process.env), "mcp-oauth.db"),
      keys,
    );
    session = await startMcpOAuthLogin({
      server,
      tokenStore: store,
      resolveSecret: async (reference) =>
        (
          await (context.secretResolver ?? new CompositeSecretResolver()).resolve(reference)
        ).reveal(),
    });
    if (session.authorizationUrl.length === 0) {
      printAuthResult(context.out, program, { status: "authorized" });
    } else {
      printAuthResult(context.out, program, {
        status: "authorization_required",
        authorizationUrl: session.authorizationUrl,
      });
      if (options.open === true) {
        try {
          await (openBrowser ?? openUrlInBrowser)(session.authorizationUrl);
        } catch {
          throw new ServersCommandError("server_browser_open_failed");
        }
      }
    }
    await session.complete;
  } catch (error) {
    if (error instanceof ServersCommandError || error instanceof McpAuthRequiredError) {
      throw error;
    }
    throw new McpAuthRequiredError();
  } finally {
    await session?.close();
    store?.close();
    keys.dispose();
  }
}

async function runServersLogout(
  serverId: string,
  program: Command,
  context: CliContext,
): Promise<void> {
  const parsedId = Code.safeParse(serverId);
  if (!parsedId.success) {
    throw new ServersCommandError("mcp_server_not_found");
  }
  const core = await import("@harness/core");
  const keys: KeyProvider = {
    currentKeyId: () => "logout",
    getKey: () => Promise.reject(new OAuthTokenStoreError()),
  };
  const store = await OAuthTokenStore.open(
    join(core.resolveDataDir(process.env), "mcp-oauth.db"),
    keys,
  );
  try {
    store.delete(parsedId.data);
    printAuthResult(context.out, program, { status: "logged_out" });
  } finally {
    store.close();
  }
}

/** Registers the OAuth login and logout subcommands. */
export function registerServersAuthCommands(
  servers: Command,
  program: Command,
  context: CliContext,
  openBrowser: ((url: string) => Promise<void>) | undefined,
): void {
  servers
    .command("login")
    .description("Authorize a remote MCP server")
    .argument("<id>", "configured server id")
    .option("--open", "open the authorization URL in a browser")
    .action((id: string, options: { readonly open?: boolean }) =>
      runServersLogin(id, options, { program, context, openBrowser }),
    );
  servers
    .command("logout")
    .description("Remove stored OAuth credentials for a server")
    .argument("<id>", "configured server id")
    .action((id: string) => runServersLogout(id, program, context));
}
