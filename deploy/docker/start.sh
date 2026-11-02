#!/bin/sh
# HTTP containers cannot own task consumers. Fail before migrations so stale
# combined-mode deployments cannot appear healthy while silently losing jobs.
if [ "${WORKER_MODE:-disabled}" != "disabled" ] || [ "${DEDICATED_WORKER:-false}" != "false" ]; then
    echo "Web startup requires WORKER_MODE=disabled and DEDICATED_WORKER=false (found WORKER_MODE=${WORKER_MODE:-unset}, DEDICATED_WORKER=${DEDICATED_WORKER:-unset})." >&2
    echo "Remove both variables from this container and run one separate worker container with command ./start-worker.sh." >&2
    echo "Upgrade guide: https://lumastra.org/guides/deploy-docker/#upgrading-to-the-dedicated-worker-and-two-valkeys" >&2
    exit 64
fi
export WORKER_MODE=disabled
export DEDICATED_WORKER=false
echo "🚀 Starting Lumastra container..."

echo "Ensuring transcode engine..."
sh scripts/fetch-ffmpeg.sh

echo "Running database migration..."
# --import registers the .lua?raw text loader (scripts/register-lua.mjs) so the
# migration import chain (connection.ts → services → tasks/lua/loader.ts) can be
# loaded under tsx over TS source. Without it, tsx crashes on the loader's
# `import … from './*.lua?raw'` with ERR_UNKNOWN_FILE_EXTENSION and the container
# never boots. See scripts/tsx-lua-loader.mjs.
NODE_OPTIONS="${NODE_OPTIONS:-} --import ./scripts/register-lua.mjs" \
  node_modules/.bin/tsx --tsconfig tsconfig.scripts.json scripts/startup-migration.ts
if [ $? -ne 0 ]; then
  echo "❌ Migration failed, check logs above"
  exit 1
fi
echo "✅ Migration completed"

# Retain hashed client assets across deploys so stale open tabs can still
# lazy-load chunks from previous builds. SvelteKit returns /_app 404s before
# hooks run, so restore into sirv's tree when writable. Read-only images use
# the history fallback handler. The internal budget and hard shell timeout
# bound all asset I/O, including mkdir. Never fatal: /config may not be mounted.
ASSET_HISTORY_DIR="${ASSET_HISTORY_DIR:-/config/asset-history}"
# Count distinct builds, including this build, regardless of deployment age.
ASSET_HISTORY_BUILDS="${ASSET_HISTORY_BUILDS:-3}" \
    timeout -s KILL 60s node scripts/restore-immutable-assets.mjs "$ASSET_HISTORY_DIR" build/client/_app/immutable \
    || echo "Warning: asset history maintenance failed or timed out; skipped remaining work" >&2

if [ "$LUMASTRA_LOW_RAM_MODE" = "true" ]; then
    case "$NODE_OPTIONS" in
        *--max-old-space-size*)
            echo "LUMASTRA_LOW_RAM_MODE set, but NODE_OPTIONS already has --max-old-space-size — leaving it as-is"
            ;;
        *)
            export NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=768"
            echo "LUMASTRA_LOW_RAM_MODE: capping V8 old-space at 768MB (web-only)"
            ;;
    esac
fi

echo "Starting application server..."
exec node build
