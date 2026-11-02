// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { TaskDefinition, TaskContext, TaskResult } from '@sapd/lumastra-plugin-sdk';
import { mockContext } from './mock-context.js';

export async function runTask<I, R>(
    task: TaskDefinition<I, R>,
    input: I,
    ctxOverrides?: Partial<TaskContext<I>>,
): Promise<TaskResult<R>> {
    const ctx = mockContext<I>({ input, ...ctxOverrides });
    return task.execute(ctx);
}
