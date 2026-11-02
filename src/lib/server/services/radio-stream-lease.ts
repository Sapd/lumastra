// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A radio response can stay open indefinitely. Recheck its scoped grant while
 * delivering, so stop, kill, account/access revocation and expiry end existing
 * connections too. Abort cancels the upstream reader even when it is stalled.
 */
export function leaseRadioStream(
    source: ReadableStream<Uint8Array>,
    requestSignal: AbortSignal,
    authorized: () => Promise<boolean>,
): ReadableStream<Uint8Array> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    let checking = false;
    const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void authorized()
            .then((allowed) => {
                if (!allowed) controller.abort();
            })
            .catch(() => controller.abort())
            .finally(() => {
                checking = false;
            });
    }, 10_000);
    timer.unref();
    requestSignal.addEventListener('abort', abort, { once: true });
    if (requestSignal.aborted) abort();
    void source
        .pipeTo(stream.writable, { signal: controller.signal })
        .catch(() => {
            // Cancellation errors already reach the response's reader.
        })
        .finally(() => {
            clearInterval(timer);
            requestSignal.removeEventListener('abort', abort);
        });
    return stream.readable;
}
