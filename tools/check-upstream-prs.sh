#!/bin/sh
# Fail if any pull request of ours is open against the upstream project.
#
# A pull request lives in the repository it targets and only points at a branch in this fork, so it
# can appear upstream without anything ever being pushed there. Branch and push checks cannot see
# that; this can. See Card-Forge/forge#11612 for the one that got through.
#
# Exit codes: 0 nothing of ours is open upstream (or the check could not run), 1 something is.

UPSTREAM="Card-Forge/forge"
OWNER="PtrckAraujo"
# UPSTREAM_PR_API exists so this check can be pointed at a fixture and shown to fire; a guard
# nobody has watched trip is not a guard.
API="${UPSTREAM_PR_API:-https://api.github.com/repos/$UPSTREAM/pulls?state=open&per_page=100}"

if ! command -v python3 >/dev/null 2>&1; then
    echo "check-upstream-prs: python3 not found, skipping" >&2
    exit 0
fi

if [ -n "$GH_TOKEN" ]; then
    BODY=$(curl -sS -H "Authorization: Bearer $GH_TOKEN" "$API" 2>/dev/null)
elif [ -n "$GITHUB_TOKEN" ]; then
    BODY=$(curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" "$API" 2>/dev/null)
else
    BODY=$(curl -sS "$API" 2>/dev/null)
fi

# Unreachable, rate limited, or sandboxed: say so rather than pretending it is clean.
printf '%s' "$BODY" | python3 -c '
import json, sys

raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    print("check-upstream-prs: no usable response, skipping", file=sys.stderr)
    raise SystemExit(0)

if not isinstance(data, list):
    print("check-upstream-prs: upstream not reachable from here, skipping", file=sys.stderr)
    print("  (" + str(data.get("message", ""))[:120] + ")", file=sys.stderr)
    raise SystemExit(0)

owner = "'"$OWNER"'".lower()
ours = [p for p in data if (p.get("user") or {}).get("login", "").lower() == owner]
if not ours:
    raise SystemExit(0)

print("", file=sys.stderr)
print("UPSTREAM PULL REQUEST OPEN - this work is not meant for '"$UPSTREAM"'", file=sys.stderr)
for p in ours:
    print("  #%s  %s" % (p["number"], p.get("title", "")), file=sys.stderr)
    print("      %s -> %s" % (p["head"]["label"], p["base"]["label"]), file=sys.stderr)
    print("      %s" % p["html_url"], file=sys.stderr)
print("", file=sys.stderr)
print("  Close it. The branch stays in the fork; only the pull request is in the", file=sys.stderr)
print("  wrong place, and the same work can be reopened against PtrckAraujo:master.", file=sys.stderr)
print("", file=sys.stderr)
raise SystemExit(1)
'
