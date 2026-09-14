#!/usr/bin/env bash
# UserPromptSubmit: recover prompts typed with the wrong keyboard layout.
#
# kbfix.mjs decides whether that happened and, only when confident, prints hook
# JSON whose additionalContext names the reading. The original prompt is never
# replaced: a false positive has to stay visible and correctable, so
# `updatedPrompt` is deliberately not used.
#
# This hook is a convenience and must never be able to interfere with a prompt.
# Every failure path is silent and exits 0: no node, no tool, bad JSON, timeout.
# `set -e` is deliberately absent for the same reason.

exit_ok() { exit 0; }
trap exit_ok EXIT

# ${CLAUDE_PLUGIN_ROOT} is set when this runs as an installed plugin. The
# BASH_SOURCE derivation is the fallback for running straight from a clone, and
# is pure bash so the hook does not depend on dirname being on PATH.
if [ -n "${CLAUDE_PLUGIN_ROOT}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/kbfix.mjs" ]; then
  tool="${CLAUDE_PLUGIN_ROOT}/scripts/kbfix.mjs"
else
  src="${BASH_SOURCE[0]}"
  here="${src%/*}"
  [ "$here" = "$src" ] && here="."
  tool="${here}/../scripts/kbfix.mjs"
fi
[ -f "$tool" ] || exit 0

# Resolve node without assuming the hook inherited a login shell's PATH.
node_bin=""
for candidate in \
  "$(command -v node 2>/dev/null)" \
  /usr/local/bin/node \
  /opt/homebrew/bin/node \
  /usr/bin/node
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
done
[ -n "$node_bin" ] || exit 0

# stdin is the UserPromptSubmit payload. kbfix prints nothing unless confident.
"$node_bin" "$tool" --hook 2>/dev/null || true
exit 0
