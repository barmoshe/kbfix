#!/usr/bin/env bash
# Hook-level tests: the wrapper's contract, not the engine's.
#
# The engine has its own gates (scripts/kbfix.mjs --self-test and --bench). What
# matters here is that the wrapper can never take a prompt down with it: every
# bad input path must exit 0 and print nothing at all.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
hook="$root/hooks/kb-layout.sh"

pass=0
fail=0

check() { # check <name> <expected-rc> <expect-output|expect-silent> <payload>
  local name="$1" want_rc="$2" mode="$3" payload="$4"
  local out rc
  out="$(printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$root" bash "$hook" 2>/dev/null)"
  rc=$?
  local ok=1
  [ "$rc" = "$want_rc" ] || ok=0
  if [ "$mode" = "silent" ]; then
    [ -z "$out" ] || ok=0
  else
    case "$out" in *"$mode"*) ;; *) ok=0 ;; esac
  fi
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1)); echo "ok    $name"
  else
    fail=$((fail + 1)); echo "FAIL  $name (rc=$rc, out=${out:0:160})"
  fi
}

echo "--- hook wrapper ---"
check "fires on a Hebrew-layout mistype"  0 'commit and push to main' \
  '{"hook_event_name":"UserPromptSubmit","prompt":"בםצצןא שמג פודי אם צשןמ"}'
check "fires on an English-layout mistype" 0 'לדוגמא' \
  '{"hook_event_name":"UserPromptSubmit","prompt":"ksudnt"}'
check "fires on a Russian mistype"         0 'привет' \
  '{"hook_event_name":"UserPromptSubmit","prompt":"ghbdtn"}'
check "silent on real Russian"             0 silent \
  '{"hook_event_name":"UserPromptSubmit","prompt":"спасибо большое за помощь"}'
check "never rewrites the prompt"          0 'additionalContext' \
  '{"hook_event_name":"UserPromptSubmit","prompt":"ksudnt"}'
check "silent on real Hebrew"              0 silent \
  '{"hook_event_name":"UserPromptSubmit","prompt":"אני צריך לבדוק את הקובץ הזה"}'
check "silent on real Hebrew (2)"          0 silent \
  '{"hook_event_name":"UserPromptSubmit","prompt":"תודה רבה על העזרה"}'
check "silent on real English"             0 silent \
  '{"hook_event_name":"UserPromptSubmit","prompt":"can you check the hook please"}'
check "fails open on malformed stdin"      0 silent 'not json at all'
check "fails open on empty stdin"          0 silent ''
check "fails open on a missing prompt"     0 silent '{"hook_event_name":"UserPromptSubmit"}'

# The payload must never be able to smuggle `updatedPrompt` into the output.
out="$(printf '%s' '{"prompt":"ksudnt"}' | CLAUDE_PLUGIN_ROOT="$root" bash "$hook" 2>/dev/null)"
case "$out" in
  *updatedPrompt*) fail=$((fail + 1)); echo "FAIL  output must never contain updatedPrompt" ;;
  *) pass=$((pass + 1)); echo "ok    output never contains updatedPrompt" ;;
esac

echo
echo "--- engine ---"
if node "$root/scripts/kbfix.mjs" --self-test > /dev/null 2>&1; then
  pass=$((pass + 1)); echo "ok    kbfix --self-test"
else
  fail=$((fail + 1)); echo "FAIL  kbfix --self-test (run it directly to see why)"
fi
if node "$root/scripts/kbfix.mjs" --bench > /dev/null 2>&1; then
  pass=$((pass + 1)); echo "ok    kbfix --bench"
else
  fail=$((fail + 1)); echo "FAIL  kbfix --bench (run it directly to see the false positives)"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
