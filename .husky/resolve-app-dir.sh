# Sourced by the hooks (not a hook itself: husky only runs files named after one).
#
# Sets $app_dir to THIS package inside the tree being committed or pushed, and cds there.
#
# Not the directory of the hook file. core.hooksPath is an absolute path into the main
# checkout (see scripts/prepare-husky.mjs), so in a `git worktree` $0 still points at the
# MAIN checkout. A hook that cds next to itself lints, and diffs specs from, the main
# checkout's working tree against the worktree's commit, which is a different branch. That
# reported the worktree's untouched specs as "changed but not staged" and blocked the commit.
# git runs hooks from the top of the tree being committed, so resolve from there.
#
# The package's path inside the repo comes from the hook's own checkout: the package may be
# the repository root or a subdirectory of a larger one. The GIT_*
# variables are cleared for that one call. A commit exports GIT_INDEX_FILE, and git also
# honours GIT_DIR, so either would answer for the wrong checkout.
hook_home=$(cd "$(dirname -- "$0")/.." && pwd)
app_prefix=$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git -C "$hook_home" rev-parse --show-prefix)
top=$(git rev-parse --show-toplevel)
app_dir="$top/$app_prefix"

# Pin git to this tree before leaving its top, for everything the hooks start. A commit in
# a linked worktree exports GIT_DIR without GIT_WORK_TREE, and git then takes the CURRENT
# directory as the top of the work tree: from the package subdirectory every tracked file
# outside it reads as deleted.
GIT_DIR=$(git rev-parse --absolute-git-dir)
GIT_WORK_TREE=$top
export GIT_DIR GIT_WORK_TREE

cd "$app_dir"

# A linked worktree usually has no node_modules, and every tool the hooks run resolves
# its config and plugins from the tree it runs in. Borrowing the main checkout's copy is
# not an option: eslint.config.js would still fail to import its plugins.
has_node_modules() { [ -d node_modules ]; }
