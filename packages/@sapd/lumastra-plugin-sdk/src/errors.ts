// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

export type TaskErrorKind = 'transient' | 'permanent' | 'fatal';

export class TaskError extends Error {
    readonly kind: TaskErrorKind;
    override readonly cause?: unknown;
    /** Operator remedy, independent of retryability; survives worker isolation. */
    readonly remediation?: 'identity' | 'operational';

    constructor(opts: {
        message: string;
        kind: TaskErrorKind;
        cause?: unknown;
        remediation?: 'identity' | 'operational';
    }) {
        super(opts.message);
        this.name = 'TaskError';
        this.kind = opts.kind;
        this.cause = opts.cause;
        this.remediation = opts.remediation;
    }
}

export class PluginDefinitionError extends Error {
    readonly taskId: string;
    readonly phase: 'registration' | 'execution';
    /** Contract that produced the error (e.g. 'defineTask', 'defineProvider'). */
    readonly contract: string;

    constructor(opts: {
        id: string;
        message: string;
        phase: 'registration' | 'execution';
        /**
         * Name of the defineX() helper that produced this error. Defaults to
         * 'defineTask' for backwards compatibility with the original
         * task-only error.
         */
        contract?: string;
    }) {
        const contract = opts.contract ?? 'defineTask';
        super(`${contract}(${opts.id}): ${opts.message}`);
        this.name = 'PluginDefinitionError';
        this.taskId = opts.id;
        this.phase = opts.phase;
        this.contract = contract;
    }
}

/**
 * Thrown by `ctx.ai.ask(...)` when the proprietary AI assistant module is
 * absent (OSS build) or the `aiAssistant` entitlement is off. Plugins should
 * guard with `ctx.ai?` and treat this as "AI feature unavailable".
 */
export class AiUnavailableError extends Error {
    constructor(message = 'AI assistant is not available') {
        super(message);
        this.name = 'AiUnavailableError';
    }
}
