// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * A model can emit any number of tool calls in one round, and `dispatch.ts`
 * runs a round's calls in parallel. Without a cap one prompt fans out into
 * dozens of embedding calls + vector queries per round, or a bulk write storm.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { runAssistantToolLoop } from './dispatch.js';
import type { AssistantTool, AssistantToolContext } from './types.js';
import type { ChatProvider, ChatResult } from '../assistant-provider/types.js';

const calls = (name: string, n: number): ChatResult['toolCalls'] =>
    Array.from({ length: n }, (_, i) => ({ id: `${name}-${i}`, name, argumentsJson: '{}' }));

function result(toolCalls: ChatResult['toolCalls'], text = ''): ChatResult {
    return {
        text,
        toolCalls,
        providerRaw: null,
        usage: { inputTokens: 1, outputTokens: 1 },
        usageMissing: false,
    };
}

function makeTool(name: string, execute: () => void): AssistantTool {
    return {
        name,
        description: name,
        argsSchema: z.object({}),
        execute: async () => {
            execute();
            return { summaryForModel: '{"ok":true}' };
        },
    };
}

function run(tool: AssistantTool, script: ChatResult[]) {
    const createChat = vi.fn();
    for (const r of script) createChat.mockResolvedValueOnce(r);
    createChat.mockResolvedValue(result([], 'done'));
    const provider = {
        model: 'm',
        supportsTools: () => true,
        createChat,
        createChatStream: vi.fn(),
    } as unknown as ChatProvider;
    return runAssistantToolLoop({
        provider,
        systemPrompt: 's',
        userMessage: 'q',
        tools: [tool],
        ctx: {} as AssistantToolContext,
    });
}

describe('tool-call caps', () => {
    it('executes at most 8 calls from one round', async () => {
        const execute = vi.fn();
        const loop = await run(makeTool('search_library', execute), [
            result(calls('search_library', 100)),
        ]);
        expect(execute).toHaveBeenCalledTimes(8);
        expect(loop.toolCallCount).toBe(8);
    });

    it('executes at most 16 calls across one invocation', async () => {
        const execute = vi.fn();
        await run(makeTool('search_library', execute), [
            result(calls('search_library', 8)),
            result(calls('search_library', 8)),
            result(calls('search_library', 8)),
        ]);
        expect(execute.mock.calls.length).toBeLessThanOrEqual(16);
    });

    it('answers a refused call with an error the model can read', async () => {
        const createChat = vi.fn();
        createChat.mockResolvedValueOnce(result(calls('search_library', 10)));
        createChat.mockResolvedValue(result([], 'done'));
        const provider = {
            model: 'm',
            supportsTools: () => true,
            createChat,
            createChatStream: vi.fn(),
        } as unknown as ChatProvider;
        await runAssistantToolLoop({
            provider,
            systemPrompt: 's',
            userMessage: 'q',
            tools: [makeTool('search_library', () => undefined)],
            ctx: {} as AssistantToolContext,
        });
        const second = createChat.mock.calls[1][0] as {
            messages: Array<{ role: string; content?: string }>;
        };
        const toolMessages = second.messages.filter((m) => m.role === 'tool');
        expect(toolMessages).toHaveLength(10);
        expect(toolMessages[9].content).toContain('too many tool calls');
    });

    it('executes at most 3 write calls in one invocation', async () => {
        const execute = vi.fn();
        await run(makeTool('mark_watched', execute), [result(calls('mark_watched', 6))]);
        expect(execute).toHaveBeenCalledTimes(3);
    });
});
