// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export { resolveImageSets, resolveImageSet, resolveImageSpecsForOwner, userAvatarSet } from './resolver.js';
export type { ImageItem, ResolveImageOptions } from './resolver.js';
export { chainFor, IMAGE_CHAINS } from './chains.js';
export { imageRevision, IMAGE_ALGO_VERSION } from './revision.js';

export {
    personImageSet,
    channelImageSet,
    libraryImageSet,
    audiobookImageSet,
    playlistImageSet,
} from './resources.js';
export { userImageSets } from './avatars.js';

export { resolvePersonImageSet } from './people.js';
export { resolveSelectedImageCandidate } from './selected.js';
