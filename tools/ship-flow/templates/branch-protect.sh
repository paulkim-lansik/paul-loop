#!/usr/bin/env bash
# branch-protect.sh — idempotently apply GitHub branch protection to one branch.
#
# The real boundary against an unreviewed change landing on a shared branch is server-side branch
# protection, not a local pre-commit hook (a hook is best-effort and bypassable — see any local
# "guardrail" this repo may also have). This script is what actually sets that boundary.
#
# Usage:
#   branch-protect.sh <owner/repo> <branch> --require-pr [--required-check "<job name>"] \
#                      [--include-admins] [--no-force-push] [--no-delete]
#
# Examples:
#   # Release branch: PR required, a named CI job must pass, admins included, no force-push/delete.
#   branch-protect.sh myorg/myrepo main --require-pr --required-check "CI gate" \
#                      --include-admins --no-force-push --no-delete
#
#   # Integration branch: PR required, no CI requirement (e.g. this repo doesn't run CI on PRs into
#   # it — a common cost-control pattern), still no force-push/delete.
#   branch-protect.sh myorg/myrepo develop --require-pr --no-force-push --no-delete
#
# Requires: `gh` authenticated with admin access to the target repo.
#
# Idempotent: re-running with the same arguments produces the same protection config — safe to run
# again if you're not sure it applied, or to adjust one flag without hand-editing GitHub's API body.

set -euo pipefail

REPO="${1:?usage: branch-protect.sh <owner/repo> <branch> [flags...]}"
BRANCH="${2:?usage: branch-protect.sh <owner/repo> <branch> [flags...]}"
shift 2

REQUIRE_PR=false
REQUIRED_CHECK=""
INCLUDE_ADMINS=false
NO_FORCE_PUSH=false
NO_DELETE=false

while [ $# -gt 0 ]; do
  case "$1" in
    --require-pr) REQUIRE_PR=true; shift ;;
    --required-check) REQUIRED_CHECK="$2"; shift 2 ;;
    --include-admins) INCLUDE_ADMINS=true; shift ;;
    --no-force-push) NO_FORCE_PUSH=true; shift ;;
    --no-delete) NO_DELETE=true; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Build the required_status_checks block — omitted entirely (null) if no check was named, since an
# empty-but-present block behaves differently from "no status check requirement" in the API.
if [ -n "$REQUIRED_CHECK" ]; then
  STATUS_CHECKS_JSON=$(printf '{"strict": true, "contexts": [], "checks": [{"context": "%s"}]}' "$REQUIRED_CHECK")
else
  STATUS_CHECKS_JSON="null"
fi

PR_REVIEWS_JSON="null"
if [ "$REQUIRE_PR" = "true" ]; then
  PR_REVIEWS_JSON='{"required_approving_review_count": 0}'
fi

BODY=$(cat <<JSON
{
  "required_status_checks": ${STATUS_CHECKS_JSON},
  "enforce_admins": ${INCLUDE_ADMINS},
  "required_pull_request_reviews": ${PR_REVIEWS_JSON},
  "restrictions": null,
  "allow_force_pushes": $([ "$NO_FORCE_PUSH" = "true" ] && echo false || echo true),
  "allow_deletions": $([ "$NO_DELETE" = "true" ] && echo false || echo true),
  "required_linear_history": false,
  "block_creations": false
}
JSON
)

echo "Applying branch protection: $REPO@$BRANCH"
echo "$BODY" | gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" --input - >/dev/null
echo "Done. Verify with: gh api repos/${REPO}/branches/${BRANCH}/protection"
