// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Derive OpenAI chat-completion tool definitions from assistant tools.
 *
 * The parameter JSON Schema is produced from each tool's Zod `argsSchema` via
 * `z.toJSONSchema()` — the SAME schema the dispatch loop validates arguments
 * against — so the model's contract and our runtime validation can never
 * drift. We strip the `$schema` marker and defensively inline any
 * `$defs`/`$ref` (which `.meta({ id })` schemas would otherwise emit) so the
 * resulting parameters object is flat, self-contained, and OpenAI-safe.
 *
 * @module server/assistant/assistant-tools/to-openai-schema
 */

import type OpenAI from 'openai';
import { z } from 'zod';
import type { AssistantTool } from './types.js';
import type { NeutralToolDef } from '../assistant-provider/types.js';

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Recursively replace `{ $ref: '#/$defs/X' }` nodes with the inlined
 * definition body (dropping the non-standard `id` keyword), then remove the
 * top-level `$defs` and `$schema`. Defensive: our first-party tool schemas
 * are already flat, but this keeps the builder correct if a tool reuses a
 * `.meta({ id })` schema.
 */
function inlineDefs(root: JsonObject): JsonObject {
    const defs = isObject(root.$defs) ? (root.$defs as JsonObject) : {};

    const walk = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(walk);
        if (!isObject(node)) return node;

        const ref = node.$ref;
        if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
            const key = ref.slice('#/$defs/'.length);
            const target = defs[key];
            if (isObject(target)) {
                const { id: _id, ...rest } = target;
                return walk(rest);
            }
        }

        const out: JsonObject = {};
        for (const [k, v] of Object.entries(node)) {
            if (k === '$defs' || k === '$schema') continue;
            out[k] = walk(v);
        }
        return out;
    };

    return walk(root) as JsonObject;
}

/**
 * Compute the flat, self-contained JSON Schema for a tool's arguments. Shared
 * by every provider's tool-definition builder so the model's contract and our
 * runtime Zod validation can never drift.
 */
export function buildToolParameters(tool: AssistantTool): JsonObject {
    const raw = z.toJSONSchema(tool.argsSchema, {
        target: 'draft-2020-12',
    }) as JsonObject;
    return inlineDefs(raw);
}

/**
 * Build provider-neutral tool definitions ({@link NeutralToolDef}). Each chat
 * provider formats these to its own wire schema (OpenAI `function`, Anthropic
 * `input_schema`).
 */
export function buildNeutralToolDefs(tools: readonly AssistantTool[]): NeutralToolDef[] {
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: buildToolParameters(tool),
    }));
}

/**
 * Build a single OpenAI tool definition from an assistant tool.
 */
export function buildToolDefinition(
    tool: AssistantTool,
): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
    const parameters = buildToolParameters(tool);

    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters,
        },
    };
}

/**
 * Build the full OpenAI `tools` array from a registry of assistant tools.
 */
export function buildToolDefinitions(
    tools: readonly AssistantTool[],
): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
    return tools.map(buildToolDefinition);
}
