// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Capability gate: decide whether the assistant should run the tool-calling
 * loop or fall back to single-shot RAG.
 *
 * Safe-by-default for unknown models: OSS users may point `OPENAI_BASE_URL`
 * at a weak/local LLM that cannot do function calling. Unless the model name
 * is recognised as tool-capable (or `ASSISTANT_TOOLS_FORCE` is set), we fall
 * back to the single-shot path so those deployments keep working.
 *
 * @module server/proprietary/assistant-tools/capability
 */

import { config } from '../../config.js';

/**
 * Known tool-capable OpenAI model families. Matched case-insensitively
 * against the start of the configured model name. Extend as new families
 * ship. Deliberately an allow-list: anything unrecognised is treated as
 * non-tool-capable.
 */
const TOOL_CAPABLE_MODEL_PATTERNS: readonly RegExp[] = [
    /^gpt-4o/i,
    /^chatgpt-4o/i,
    /^gpt-4\.1/i,
    /^gpt-4-turbo/i,
    /^gpt-4-0125/i,
    /^gpt-4-1106/i,
    /^gpt-5/i,
    /^o1/i,
    /^o3/i,
    /^o4/i,
    // Anthropic Claude — all current models do native tool use.
    /^claude-/i,
];

/**
 * Whether a given chat model name is recognised as supporting tool-calling.
 */
export function modelSupportsTools(model: string): boolean {
    const name = (model ?? '').trim();
    if (!name) return false;
    return TOOL_CAPABLE_MODEL_PATTERNS.some((re) => re.test(name));
}

/**
 * Whether the assistant tool-calling loop should be used for this request.
 *
 * @param model - the configured chat model (`ai.openaiChatModel`).
 */
export function assistantToolsEnabled(model: string): boolean {
    if (!config.FEATURE_ASSISTANT_TOOLS) return false;
    if (config.ASSISTANT_TOOLS_FORCE) return true;
    return modelSupportsTools(model);
}
