#!/usr/bin/env bash
# A step of .github/workflows/upstream-sync.yml: moves main to the candidate
# commit, once its tests have passed. Run in a checkout of the candidate.
#
# Environment:
#   SHA                the candidate commit
#   BASE               the commit of main the candidate was made on
#   PUSH_URL           where to push
#   CANDIDATE_BRANCH   the branch the candidate is on (deleted afterwards)
set -euo pipefail

# The candidate is the commit the first job made: one commit on top of the
# main it started from, with nothing but release files in it.
if [ "$(git rev-parse HEAD)" != "$SHA" ]; then
  echo "::error::The checkout is not the candidate $SHA"
  exit 1
fi
if [ "$(git rev-parse HEAD^)" != "$BASE" ]; then
  echo "::error::The candidate $SHA is not one commit on top of $BASE"
  exit 1
fi
others=$(git diff --no-renames --name-only "$BASE" "$SHA" | grep -v -E '^([A-Za-z0-9][A-Za-z0-9._-]*\.(crx|xpi|zip)|release-hashes\.txt)$' || true)
if [ -n "$others" ]; then
  echo "::error::The candidate changes more than release files"
  printf '%s\n' "$others"
  exit 1
fi

# Not forced: this fails when main has moved since the candidate was made, and
# the next run starts over.
git push --quiet "$PUSH_URL" "$SHA:refs/heads/main"
git push --quiet "$PUSH_URL" --delete "$CANDIDATE_BRANCH" || true
