// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { makeToken } from './tokens.js';

/** @param {string} body @param {string} botName */
export function mentionsBot(body, botName) {
    if (!botName) return false;
    const re = new RegExp(`@${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return re.test(body);
}

/**
 * Map recent rows to assistant history. Bot rows → assistant; others → "name: text".
 * The "user" turns here are OTHER PEOPLE'S room messages, not the asker's own:
 * the host fences ctx.ai history as untrusted third-party text and runs the
 * shared-surface (no personal data) assistant, so this stays a plain mapping.
 */
export function buildHistory(msgs) {
    return msgs.map((m) =>
        m.author_kind === 'ai'
            ? { role: 'assistant', content: m.body }
            : { role: 'user', content: `${m.username}: ${m.body}` },
    );
}

/**
 * If `body` mentions the bot and AI is enabled, ask the host AI as the asker and
 * post the reply as a bot message. Detached caller — never throws to the route.
 * `deps` is injected for testing (defaults to the real query module).
 */
export async function maybeAnswer(ctx, userMsg, body, deps) {
    try {
        const cfg = await ctx.settings();
        if (!cfg.aiEnabled || !ctx.ai) return;
        const botName = cfg.aiBotName || 'mybot';
        if (!mentionsBot(body, botName)) return;

        const { insertMessage, listRecent, reserveAiInvocation } =
            deps ?? (await import('./queries.js'));
        const { enrichForHistory } = await import('./media.js').catch(() => ({}));
        void enrichForHistory; // history token-scoping handled in B7.1 follow-up

        const n = Number(cfg.aiContextMessages) || 0;
        let history = [];
        if (n > 0) {
            const recent = await listRecent(ctx.sql, n);
            const scoped =
                cfg.aiContextScope === 'asker-only'
                    ? recent.filter(
                          (m) => m.username === userMsg.username || m.author_kind === 'ai',
                      )
                    : recent;
            history = buildHistory(scoped, botName);
        }

        const prompt = body.replace(new RegExp(`@${botName}\\b`, 'ig'), '').trim();
        // When the body is only the mention, there is no question — don't spend
        // an AI call/cost on an empty prompt.
        if (!prompt) return;

        // security review 2026-09-13, C25: `aiRateLimitPerHour` was a declared
        // setting nobody read — only the host's daily TOKEN budget capped AI
        // usage (assistant-service.ts), so one user hammering @botname could
        // exhaust it before anyone else got a turn. Reserve a slot atomically
        // (closes the same TOCTOU race insertUserMessageRateLimited closes for
        // regular posts) BEFORE spending a ctx.ai.ask call. A message with no
        // user_id can't be rate-limited safely, so fail closed (no reply)
        // rather than skip the cap — the route already refuses to accept
        // human posts without a user_id, so this only guards against a host
        // that predates PluginUser.userId or a future non-route caller.
        if (!userMsg.user_id) {
            ctx.logger?.warn?.('[shoutbox] maybeAnswer: message has no user_id, skipping AI reply');
            return;
        }
        const aiRateLimitPerHour = Math.max(0, Math.trunc(Number(cfg.aiRateLimitPerHour) || 0));
        const reserved = await reserveAiInvocation(ctx.sql, {
            userId: userMsg.user_id,
            limit: aiRateLimitPerHour,
            windowSeconds: 3600,
        });
        // Cap reached: bail silently — no bot reply, no user-visible
        // rate-limit message. An unanswered mention is unremarkable in a
        // busy shoutbox, and a "you're rate limited" bot line would itself
        // cost another AI-adjacent write for no benefit.
        if (!reserved) return;

        // SECURITY: ctx.ai.ask has NO asUserId — RAG is bound host-side to the
        // request's authenticated viewer. The bot reply runs during the asker's
        // POST request, so `ctx.user` IS the asker; recommendations are correctly
        // scoped to them with no spoofing possible. (Detached call must still hold
        // this request's ctx — do not reuse a ctx across users.)
        const answer = await ctx.ai.ask({
            prompt,
            history,
            systemHint: cfg.aiSystemHint || undefined,
        });
        // AI backend may return no result — bail rather than dereference null.
        if (!answer) return;

        // recommendedMedia is untrusted LLM output: skip any item whose id is
        // not a valid token id rather than letting one bad item throw and abort
        // the whole reply.
        const tokens = (answer.recommendedMedia ?? [])
            .map((m) => {
                try {
                    return makeToken(m?.id, m?.mediaType);
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .join(' ');
        const replyBody = [answer.text, tokens].filter(Boolean).join('\n');

        const [row] = await insertMessage(ctx.sql, {
            username: botName,
            userGroup: 'ai',
            body: replyBody,
            authorKind: 'ai',
            replyTo: userMsg.id,
        });
        // Security fix C27, fix round 1 (2026-09-16): the host's realtime
        // SSE bridge forwards every published frame verbatim to every
        // connected client regardless of this room's own readGroups — see
        // index.js's POST /messages publish for the full rationale. A bare
        // id is enough: the widget re-fetches the full message (including
        // knowing it's from the bot) through the gated route.
        await ctx.realtime?.publish('message', { id: row.id });
    } catch (err) {
        // Detached caller contract: never throw to the route. Log and swallow.
        ctx.logger?.warn?.('[shoutbox] maybeAnswer failed', err);
    }
}
