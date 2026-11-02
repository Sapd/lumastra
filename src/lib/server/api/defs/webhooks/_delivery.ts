// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Empty-filter exclusion is covered by services/notification-forwarder.integration.test.ts.
export const WEBHOOK_DELIVERY_DESCRIPTION = [
    'Production event types are listed by `GET /webhooks/events`; `eventFilter: []` matches delivered task and media types only. User notifications require explicit selection and user opt-in.',
    'Delivery is at least once: deduplicate using `X-Lumastra-Event-Id`, the CloudEvent id stable across attempts, not a per-attempt id.',
    'POST bodies are signed with `X-Lumastra-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>`.',
    'Verify HMAC-SHA256(secret, `${t}.${rawBody}`) against v1 using the exact raw body bytes, a constant-time comparison and a ±5 minute timestamp window.',
    'After failures, retries wait 5 s, 30 s, 5 min, 30 min, 2 h, 12 h, then 24 h (capped at 24 h for further attempts if configured). The default is 8 total attempts; HTTP 404/410 immediately end delivery.',
    'Each attempt has a 30 s fetch timeout. Same-origin redirects are allowed; changes of scheme, host or port are rejected and count as delivery failures.',
].join(' ');
