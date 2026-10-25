// SPDX-License-Identifier: Apache-2.0
import { Id } from "@rovinos/schemas";
import { Client, type Notification, type Pool } from "pg";
import { ChangeEmitter, type ChangeSubscription } from "@rovinos/store/adapter-internal";
import { StoreUnavailableError } from "@rovinos/store/adapter-internal";
import { integer, storeError } from "./helpers.js";

/** Listen for committed harness event notifications on a dedicated connection. */
export async function listenForChanges(
  client: Client,
  onNotification: (message: Notification) => void,
): Promise<{ close: () => Promise<void> }> {
  client.on("notification", onNotification);
  try {
    await client.query("LISTEN harness_events");
  } catch (error) {
    client.removeListener("notification", onNotification);
    throw storeError(error);
  }
  return {
    async close() {
      client.removeListener("notification", onNotification);
      await client.query("UNLISTEN harness_events").catch(() => undefined);
    },
  };
}

/** Check whether the stored run has reached a terminal state through the observed head. */
export async function isRunTerminal(
  pool: Pool,
  ensureInitialized: () => Promise<void>,
  runId: Id,
  observedNextSeq: number,
): Promise<boolean> {
  try {
    await ensureInitialized();
    const result = await pool.query<{ next_seq: number | string; status: string }>(
      "SELECT next_seq, status FROM runs WHERE run_id = $1",
      [runId],
    );
    const row = result.rows[0];
    return (
      row !== undefined &&
      integer(row.next_seq) <= observedNextSeq &&
      (row.status === "completed" || row.status === "failed" || row.status === "cancelled")
    );
  } catch (error) {
    throw storeError(error);
  }
}

/** Owns the dedicated Postgres LISTEN connection shared by every store watcher. */
export class PostgresSubscriptions {
  private readonly changeEmitter = new ChangeEmitter();
  private listener: Client | undefined;
  private listenerClose: (() => Promise<void>) | undefined;
  private listenerPromise: Promise<void> | undefined;
  private listenerReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private hasConnectedListener = false;
  private listenerGlobalSeq = 0;
  private closed = false;

  constructor(
    private readonly pool: Pool,
    private readonly connectionString: string,
    private readonly schema: string,
    private readonly ensureInitialized: () => Promise<void>,
  ) {}

  async subscribe(runId: Id | undefined, signal: AbortSignal): Promise<ChangeSubscription> {
    const subscription = this.changeEmitter.subscribe(runId, signal);
    try {
      await this.ensureInitialized();
      await this.ensureListener();
    } catch (error) {
      if (!this.hasConnectedListener) {
        await subscription.cancel();
        throw error;
      }
    }
    return subscription;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.listenerReconnectTimer !== undefined) {
      clearTimeout(this.listenerReconnectTimer);
      this.listenerReconnectTimer = undefined;
    }
    await this.listenerPromise?.catch(() => undefined);
    await this.listenerClose?.();
    await this.listener?.end();
    this.listener = undefined;
    this.listenerClose = undefined;
  }

  private async ensureListener(): Promise<void> {
    if (this.closed) {
      throw new StoreUnavailableError();
    }
    if (this.listenerPromise !== undefined) {
      await this.listenerPromise;
      return;
    }
    if (this.listener !== undefined) {
      return;
    }
    this.listenerPromise = this.connectListener().finally(() => {
      this.listenerPromise = undefined;
    });
    try {
      await this.listenerPromise;
    } catch (error) {
      this.scheduleListenerReconnect();
      throw error;
    }
  }

  private async connectListener(): Promise<void> {
    const client = new Client({
      connectionString: this.connectionString,
      options: `-c search_path="${this.schema}"`,
      application_name: "harness_event_store_listener",
    });
    const onNotification = (message: Notification): void => {
      const runId = Id.safeParse(message.payload?.split(":", 1)[0]);
      if (runId.success) {
        this.changeEmitter.notify(runId.data);
      }
    };
    client.on("error", () => {
      this.listenerDisconnected(client);
    });
    client.on("end", () => {
      this.listenerDisconnected(client);
    });
    try {
      await client.connect();
      const listener = await listenForChanges(client, onNotification);
      await this.catchUpListenerChanges();
      if (this.closed) {
        await listener.close();
        await client.end().catch(() => undefined);
        return;
      }
      this.listener = client;
      this.listenerClose = listener.close;
      this.hasConnectedListener = true;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw storeError(error);
    }
  }

  private async catchUpListenerChanges(): Promise<void> {
    try {
      if (!this.hasConnectedListener) {
        const result = await this.pool.query<{ global_seq: number | string }>(
          "SELECT COALESCE(MAX(global_seq), 0) AS global_seq FROM events",
        );
        const row = result.rows[0];
        if (row !== undefined) {
          this.listenerGlobalSeq = integer(row.global_seq);
        }
        return;
      }
      const result = await this.pool.query<{
        run_id: string;
        global_seq: number | string;
      }>(
        "SELECT run_id, MAX(global_seq) AS global_seq FROM events WHERE global_seq > $1 GROUP BY run_id",
        [this.listenerGlobalSeq],
      );
      for (const row of result.rows) {
        const runId = Id.safeParse(row.run_id);
        if (runId.success) {
          this.changeEmitter.notify(runId.data);
        }
        this.listenerGlobalSeq = Math.max(this.listenerGlobalSeq, integer(row.global_seq));
      }
    } catch (error) {
      throw storeError(error);
    }
  }

  private listenerDisconnected(client: Client): void {
    if (this.listener !== client || this.closed) {
      return;
    }
    this.listener = undefined;
    this.listenerClose = undefined;
    this.scheduleListenerReconnect();
  }

  private scheduleListenerReconnect(): void {
    if (this.closed || this.listenerReconnectTimer !== undefined) {
      return;
    }
    this.listenerReconnectTimer = setTimeout(() => {
      this.listenerReconnectTimer = undefined;
      void this.ensureListener().catch(() => {
        this.scheduleListenerReconnect();
      });
    }, 250);
  }
}
