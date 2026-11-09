# Operational recovery and deployment acceptance

This audit distinguishes harness capabilities from deployment responsibilities. It does not claim
that a production deployment has been backed up or that a particular recovery objective is met.
The repository does not provide a general database backup scheduler, cross-backend restore command,
or numerical recovery-time or recovery-point objective.

## Acceptance criteria

Before calling a deployment recoverable, its operator records and approves a recovery-point objective
(RPO) and recovery-time objective (RTO) for the deployment. RPO is the maximum interval of accepted
writes that may be lost, measured from the incident to the latest consistent recovery point. RTO is
the elapsed time from declaring recovery to a healthy service that passes the checks below. The
harness defines neither value; a rehearsal must demonstrate the operator's selected values.

A passing rehearsal must use a disposable, isolated deployment containing synthetic data only and
must meet all of these conditions:

- The restored store, vault, queue, and workspace snapshots are from a recorded, compatible recovery
  point. The restore completes within the declared RTO and loses no more than the declared RPO.
- A known synthetic run can be read and resumed from its event log and workspace snapshot. A
  synthetic vault value resolves with its required key, without writing the value or key to logs,
  telemetry, or command output.
- The restored release reports no unexpected pending migrations. A failed migration leaves the
  tested database in its pre-migration state.
- Rotation can be resumed with old and current keys available. A key is not retired while live
  encrypted rows or retained backups still require it.
- Retention dry-run counts match the rehearsal inventory. The live rehearsal removes only expired
  synthetic terminal runs and their dependent data; active runs and retained recovery points remain.

Record the image/version, configuration revision, backend versions, migration versions, recovery
point timestamps, key-version references (not key material), backup checksums, actual RPO/RTO, and
pass/fail evidence. Do not include raw synthetic vault values or secrets in the record.

## Coverage and ownership

| Operation | Existing support and evidence | Owner, limitation, or gap |
| --- | --- | --- |
| Backup and restore | Workspace snapshots have bounded, checksummed restore and interrupted-swap recovery. See [snapshot tests](../packages/sandbox/src/snapshot.test.ts) and [deployment data guidance](deployment.md#data-and-backups). | The operator owns consistent backups of the event store, queue, vault, workspace snapshots, and required key versions. The harness has no end-to-end database backup/restore facility or representative full-backup restore test. |
| Key rotation and availability | `harness keys rotate` uses resumable batches; `harness keys retire` checks live store and vault references. See [key command tests](../packages/cli/src/commands/keys.test.ts), [SQLite store rotation tests](../packages/store-sqlite/src/sqlite.test.ts), [Postgres store rotation tests](../packages/store-postgres/src/postgres/adapter.test.ts), and [vault rotation tests](../packages/vault/src/sqlite.test.ts). Missing keys fail reads; see the [store key error test](../packages/store-sqlite/src/sqlite.test.ts). | The operator provisions and retains keys. Retirement counts cover live rows, not external backup copies. Before retiring a key, inventory all backups and WAL/archive copies that must remain restorable; an encrypted backup without its key is unavailable, while a backup retaining wrapped scope keys may remain decryptable after live purge. |
| Retention and deletion | Store purge supports dry-run, separate terminal-run windows, skips active runs, and reports dependent-hook failures. Vault purge is batched and idempotent; workspace snapshots are pruned. See [store retention tests](../packages/store/src/retention.test.ts), [vault purge tests](../packages/vault/src/purger.test.ts), and [snapshot retention tests](../packages/sandbox/src/snapshot-retention.test.ts). | The operator configures and schedules retention, monitors purge-hook failures, and separately expires backups, WAL, and key copies. Store deletion is not rolled back if a dependent purge hook fails; verify and reconcile those references. |
| Upgrade and migration | Store migrations are ordered, checksummed, dry-runnable, and applied transactionally. A synthetic Postgres migration failure rollback is covered by [store migration tests](../test/store-migrations.test.ts); changed checksums and newer schema versions are rejected. | Migrations are forward-only; there is no down-migration or in-place downgrade guarantee. Back up first and restore the whole compatible recovery point to roll back. Add an adapter-level SQLite failure rollback test; the existing failure test exercises a fake Postgres driver. |
| Run and worker recovery | Event-log recovery, lease reclaim, and workspace restore support resuming runs after process or worker interruption. See the [crash-injection matrix](../test/crash-injection.int.test.ts), [worker recovery tests](../packages/core/src/worker.test.ts), and [interrupted workspace swap test](../packages/sandbox/src/snapshot.test.ts). | The operator provides durable storage and configures tool idempotency/recovery. Queue leases cannot undo or guarantee exactly-once external side effects. Multi-region failover and a full disaster-recovery backup/restore path are not provided. |

Existing component tests cover purge boundaries, rotation cursors, migration checks, and workspace swap recovery. Do not duplicate those unit tests to claim a full backup restore: that remains an explicit integration-test gap.

## Synthetic recovery rehearsal

Run this procedure only in a disposable project with new temporary databases, volumes, and synthetic
credentials. Never point restore commands at production paths or databases. Use the backend's native
backup tools; the harness does not provide a universal backup command.

1. **Declare the target.** Record the approved RPO and RTO, the exact harness image/configuration, and
   the store, vault, and workspace backends. Confirm the restore targets are new and empty.
2. **Seed synthetic data.** Create a run with a uniquely identifiable synthetic event, a synthetic
   vault entry, and a checkpoint with a workspace file. Record the run ID, event head, expected
   snapshot reference, and key IDs only. Do not use production exports or copied user data.
3. **Make a consistent recovery point.** Quiesce writes across workers and runners while capturing
   the event store, queue, vault, and workspace snapshots. For SQLite, use the online backup
   mechanism or stop the harness before copying database files; never copy an active database file.
   For Postgres, use the deployment's supported consistent database backup method for both the store
   and separate vault database/schema. Capture required key versions through the secret provider,
   separately from data. Record timestamps and checksums for every artifact.
4. **Restore into the empty targets.** Use the same compatible release and configuration, restore
   the databases and snapshot volume, then provide the matching key versions through the isolated
   secret provider. Do not run a downgrade against the restored newer schema. Verify migration status
   before accepting writes.
5. **Validate recovery.** Verify the synthetic run's event head and queue state, resume it, restore
   the checkpointed workspace, and resolve the synthetic vault entry through the authorized resolver.
   Confirm the resolved value is not present in logs, telemetry, or captured command output. Record
   the actual restore duration and newest restored write timestamp; compare them to the approved RTO
   and RPO.
6. **Exercise key and migration failure paths.** In another disposable copy, first omit a required
   key and verify the encrypted content is unavailable without exposing key material. Restore the
   key, set a new current key, run the rotation, and verify old-key live row counts before and after
   retirement. Run the synthetic failure case in [store migration tests](../test/store-migrations.test.ts)
   and verify its recorded state remains unchanged. The SQLite adapter-specific failure case is a
   follow-up; do not inject a failing migration into a deployment database.
7. **Exercise retention safely.** Run `harness store purge --dry-run` against the synthetic
   configuration and compare its counts with the seeded inventory. Then purge only expired synthetic
   runs; verify active runs are retained and store, vault, and workspace references have the expected
   deletion state. Do not treat backup copies as purged when live rows are deleted.
8. **Close the rehearsal.** Record pass/fail for each check, measured RPO/RTO, residual key and backup
   references, and any cleanup performed. Keep the approved recovery copy until its retention period
   ends; destroy only the disposable rehearsal resources.

## Follow-up coverage

The uncovered work is limited to: an integration rehearsal that restores a representative synthetic
backup across store, vault, queue, keys, and workspace; a SQLite adapter test proving rollback after a
failed migration; and an end-to-end interrupted key-rotation CLI restart test. These are not implied
by the existing component tests above. Deployment-specific RPO/RTO, backup scheduling, cross-region
replication, and backup-key inventory remain operator-owned rather than repository defaults.
