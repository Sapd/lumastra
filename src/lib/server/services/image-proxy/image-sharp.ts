// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import sharp, { type Sharp } from 'sharp';
import { runImageEncode } from './encode';

/**
 * Image-serving pipelines use promise-based toBuffer(). Keep Sharp's API/types,
 * but admit and bound the actual encode, rather than metadata reads or cache hits.
 * A cache factory has already reserved its transform before single-flight starts.
 */
export default new Proxy(sharp, {
    apply(target, thisArg: unknown, args: unknown[]): Sharp {
        const pipeline = Reflect.apply(target, thisArg, args) as Sharp;
        const toBuffer = pipeline.toBuffer.bind(pipeline);
        Object.defineProperty(pipeline, 'toBuffer', {
            configurable: true,
            writable: true,
            value: (...bufferArgs: unknown[]): Promise<unknown> =>
                runImageEncode(
                    () => Reflect.apply(toBuffer, pipeline, bufferArgs) as Promise<unknown>,
                ),
        });
        return pipeline;
    },
});
