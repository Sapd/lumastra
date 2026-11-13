// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// A consumer-free execution host. Its parent owns queue locks, authority leases,
// and process-group supervision. No scheduler, watcher or recovery loop starts.
import { z } from 'zod';
import { TaskCommandSchema } from './protocol.js';
import { AuthorityStore, AuthorityError } from './authority/store.js';
import { ExecutionAdmissionRejectedError } from './executor/protocol.js';
import { RustOwnershipBlockedError } from './authority/readiness.js';
import { createTaskCatalog } from './catalog.js';
import { createBullMqExecutor } from './executor/bullmq.js';
import { startExecutorServer } from './executor/server.js';
import { reconcileExecutorAdmission } from './executor/reconcile.js';

const InitializationSchema = z
    .object({
        type: z.literal('initialize'),
        directory: z.string().min(1).max(100),
        secret: z.string().regex(/^[a-f0-9]{64}$/),
        authority: TaskCommandSchema.shape.authority,
        eligibleTaskIds: z
            .array(z.string().regex(/^[a-z][a-z0-9-]*$/))
            .max(1024)
            .refine((ids) => new Set(ids).size === ids.length),
    })
    .strict();

async function main(): Promise<void> {
    if (process.argv.includes('--check-imports')) process.exit(0);
    if (!process.send || !process.connected || process.env.WORKER_MODE !== 'disabled')
        throw new Error('Executor requires its authenticated process supervisor');
    // Guardian is independent of plugin code. This is an additional fast path
    // for loss of that guardian while the executor event loop remains live.
    process.once('disconnect', () => {
        try {
            process.kill(-process.pid, 'SIGKILL');
        } finally {
            process.exit(2);
        }
    });
    const initialization = await new Promise<z.infer<typeof InitializationSchema>>(
        (resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('Executor initialization timed out')),
                10_000,
            );
            process.once('message', (message: unknown) => {
                clearTimeout(timer);
                const result = InitializationSchema.safeParse(message);
                if (result.success) resolve(result.data);
                else reject(new Error('Invalid executor initialization'));
            });
        },
    );
    const { testDbConnection, getTaskDb, closeDb } =
        await import('$lib/server/database/connection.js');
    const { connectValkey, disconnectValkey, closeAllSubscriptions, guardTaskValkey } =
        await import('$lib/server/cache/valkey.js');
    // connectValkey() reports the task Valkey only; the cache is best-effort.
    if (!(await testDbConnection()) || !(await connectValkey()))
        throw new Error('Executor dependencies unavailable (PostgreSQL or task Valkey)');
    await guardTaskValkey();
    const sql = getTaskDb();
    if (!sql) throw new Error('Executor task database unavailable');
    const authority = new AuthorityStore(sql);
    // Actual database owner kind is checked; caller metadata cannot enable Rust
    // ownership while any legacy writer bypasses the generation boundary.
    await authority.assertExecutorAdmissionReady(initialization.authority);
    const { loadProviderConfigFromDb } =
        await import('$lib/server/providers/provider-config-loader.js');
    await loadProviderConfigFromDb(sql);
    const { ensureCompatLoaded } = await import('$lib/server/boot/compat-init.js');
    await ensureCompatLoaded();
    const { loadBuiltins } = await import('$lib/server/tasks/builtin/index.js');
    const { loadAllPlugins } = await import('$lib/server/plugins/index.js');
    await loadBuiltins();
    await loadAllPlugins(sql);
    const { applyStoredRateLimits } = await import('$lib/server/tasks/http-rate-limit.js');
    await applyStoredRateLimits(sql as never);
    const { registry } = await import('$lib/server/tasks/registry.js');
    const catalog = createTaskCatalog(registry.getAllTasks());
    const { luaLoader } = await import('$lib/server/tasks/lua/loader.js');
    await luaLoader.load();
    const backend = createBullMqExecutor({
        eligibleTaskIds: initialization.eligibleTaskIds,
        authority: initialization.authority,
    });
    const server = await startExecutorServer({
        directory: initialization.directory,
        secret: initialization.secret,
        executor: backend,
        catalogRevision: () => catalog.revision,
        authorize: async (command) => {
            const expected = initialization.authority;
            if (
                command.authority.partition !== expected.partition ||
                command.authority.generation !== expected.generation ||
                command.authority.ownerId !== expected.ownerId
            )
                throw new ExecutionAdmissionRejectedError();
            try {
                await authority.assertExecutorAdmissionReady(expected);
                await authority.admitExecution(expected, {
                    invocationId: command.invocationId,
                    dispatchId: command.dispatchId,
                    runId: command.runId,
                    taskId: command.taskId,
                });
            } catch (error) {
                if (error instanceof AuthorityError) throw new ExecutionAdmissionRejectedError();
                throw error;
            }
        },
        reconcile: (command) => reconcileExecutorAdmission(authority, command),
        lookupAdmission: (command) => reconcileExecutorAdmission(authority, command),
        settled: async (command, outcome) => {
            // The server only invokes this after actual continuation quiescence.
            // Result must be JSON and bounded by the receipt store. An unknown
            // database acknowledgment keeps the active barrier until reconciled.
            const json = z.json().parse(outcome);
            await authority.settleExecution(command.authority, command.invocationId, json, {
                dispatchId: command.dispatchId,
                quiescent: true,
            });
        },
    });
    let stopping = false;
    const shutdown = async (): Promise<void> => {
        if (stopping) return;
        stopping = true;
        const shutdownDeadlineAt = Date.now() + 5_000;
        const timeout = setTimeout(() => process.exit(2), 5_000);
        timeout.unref();
        try {
            const drained = await server.drain(4_000);
            if (!drained.quiescent) return; // Supervisor escalates, admission stays active.
            await server.close();
            await closeAllSubscriptions();
            const { flushProviderCallsForShutdown } =
                await import('$lib/server/utils/provider-calls.js');
            // Leave at least half the remaining exit window for closing Valkey and PostgreSQL.
            await flushProviderCallsForShutdown((shutdownDeadlineAt - Date.now()) / 2);
            await disconnectValkey();
            await closeDb();
            clearTimeout(timeout);
            process.exit(0);
        } catch {
            process.exitCode = 2;
        }
    };
    process.once('SIGTERM', () => {
        void shutdown();
    });
    process.once('SIGINT', () => {
        void shutdown();
    });
    process.send?.({
        type: 'ready',
        socketPath: server.socketPath,
        controlSocketPath: server.controlSocketPath,
        catalogRevision: catalog.revision,
    });
}

void main().catch((error: unknown) => {
    // Provider/plugin errors may contain credentials. Report a bounded generic
    // failure; the controller treats missing ready/completion as uncertain.
    if (error instanceof RustOwnershipBlockedError && process.connected) {
        process.send?.({ type: 'startup_rejected', code: 'activation_blocked' }, () =>
            process.exit(1),
        );
    } else process.exit(1);
});
