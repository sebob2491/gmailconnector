#!/usr/bin/env bash
# Brings the newest version of the original repository (the "upstream") into this copy's main
# branch and pushes it; Cloudflare then builds and deploys the push. Run by
# .github/workflows/update-from-upstream.yml, from the copy's main branch.
#
# - A fork (or any copy that shares the upstream's history) is merged: a fast-forward when the
#   copy has no changes of its own, otherwise a merge commit.
# - A copy made with the Deploy to Cloudflare button may have its own, unrelated history. Then the
#   upstream changes since the copy's last update are applied as one commit with a three-way apply,
#   which keeps the copy's own edits (such as the Worker name Cloudflare wrote into wrangler.jsonc).
#   The commit records the upstream commit in an "Upstream-Commit:" trailer; the next run starts
#   from there.
# - On a conflict nothing is pushed, and the run fails with a message saying what to do. It never
#   force-pushes.
#
# Settings (environment): UPSTREAM_REPO (owner/repo, default sebob2491/gmailconnector),
# GITHUB_REPOSITORY (this copy; set by GitHub), and for tests UPSTREAM_URL and PUSH_REMOTE.
set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-sebob2491/gmailconnector}"
if [[ ! "$UPSTREAM_REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "::error::UPSTREAM_REPO must look like owner/repo."
  exit 1
fi
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/${UPSTREAM_REPO}.git}"
PUSH_REMOTE="${PUSH_REMOTE:-origin}"
BRANCH=main

if [[ "${GITHUB_REPOSITORY:-}" == "" ]]; then
  echo "::error::GITHUB_REPOSITORY isn't set."
  exit 1
fi
if [[ "${GITHUB_REPOSITORY,,}" == "${UPSTREAM_REPO,,}" ]]; then
  echo "This is the upstream repository itself; nothing to update."
  exit 0
fi

fail() {
  echo "::error::$1"
  exit 1
}

commit_as_bot() {
  git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" "$@"
}

git fetch --quiet --no-tags "$UPSTREAM_URL" "+refs/heads/main:refs/remotes/upstream/main"
upstream="$(git rev-parse refs/remotes/upstream/main)"
before="$(git rev-parse HEAD)"

if git merge-base --is-ancestor "$upstream" HEAD; then
  echo "Already up to date with ${UPSTREAM_REPO} (${upstream:0:7})."
  exit 0
fi

if git merge-base HEAD "$upstream" >/dev/null 2>&1; then
  # Shared history (a fork): fast-forward, or merge the copy's own changes with the upstream's.
  if ! commit_as_bot merge --no-edit -m "Update from ${UPSTREAM_REPO} (${upstream:0:7})" "$upstream"; then
    conflicts="$(git diff --name-only --diff-filter=U | paste -sd ' ' -)"
    git merge --abort || true
    fail "The update from ${UPSTREAM_REPO} conflicts with changes made in this copy (${conflicts:-see the log above}). Nothing was changed. Merge it yourself (on GitHub: Sync fork; or git merge locally), keeping your changes where they matter."
  fi
else
  # Unrelated history (a Deploy to Cloudflare copy): apply the upstream's changes since the last update.
  base="$(git log --format='%(trailers:key=Upstream-Commit,valueonly)' HEAD | grep -m1 -E '^[0-9a-f]{40}$' || true)"
  if [[ -n "$base" ]] && ! git merge-base --is-ancestor "$base" "$upstream" 2>/dev/null; then
    base=""
  fi
  if [[ -z "$base" ]]; then
    # Never updated yet: find the upstream commit this copy was made from. First one whose files
    # match the copy's exactly (apart from wrangler config, which Cloudflare edits), otherwise the
    # newest upstream commit from before the copy's first commit.
    for candidate in $(git rev-list --max-count=500 "$upstream"); do
      if git diff --quiet "$candidate" HEAD -- . ':(exclude)wrangler.jsonc' ':(exclude)wrangler.toml' ':(exclude)wrangler.json'; then
        base="$candidate"
        break
      fi
    done
  fi
  if [[ -z "$base" ]]; then
    created="$(git log --reverse --format=%cI HEAD | head -n 1)"
    base="$(git rev-list -n 1 --before="$created" "$upstream" || true)"
  fi
  [[ -n "$base" ]] || fail "Couldn't tell which version of ${UPSTREAM_REPO} this copy started from. Update it by hand once: copy the files from ${UPSTREAM_REPO} into this repository, then commit with a last line 'Upstream-Commit: ${upstream}'."
  if [[ "$base" == "$upstream" ]]; then
    echo "Already up to date with ${UPSTREAM_REPO} (${upstream:0:7})."
    exit 0
  fi
  echo "Applying the changes from ${base:0:7} to ${upstream:0:7} of ${UPSTREAM_REPO}."
  if ! git diff --binary "$base" "$upstream" | git apply --3way --whitespace=nowarn; then
    conflicts="$(git diff --name-only --diff-filter=U | paste -sd ' ' -)"
    git reset --quiet --hard "$before"
    fail "The update from ${UPSTREAM_REPO} conflicts with changes made in this copy (${conflicts:-see the log above}). Nothing was changed. Apply it by hand, or undo your own changes to those files, then run this workflow again."
  fi
  if git diff --cached --quiet; then
    echo "The changes are already in this copy."
  fi
  commit_as_bot commit --quiet --allow-empty -m "Update from ${UPSTREAM_REPO} (${upstream:0:7})" -m "Upstream-Commit: ${upstream}"
fi

if ! git push --quiet "$PUSH_REMOTE" "HEAD:refs/heads/${BRANCH}"; then
  git reset --quiet --hard "$before"
  if [[ -n "$(git diff --name-only "$before" "$upstream" -- .github/workflows 2>/dev/null || true)" ]]; then
    fail "GitHub refused the push: the update changes a workflow file, which the workflow's built-in token may not do. Update once by hand (a fork: Sync fork on GitHub), or add a repository secret UPDATE_TOKEN holding a fine-grained personal access token for this repository with Contents and Workflows read and write, then run this workflow again."
  fi
  fail "GitHub refused the push (did ${BRANCH} change while this ran?). Nothing was changed; run this workflow again."
fi
echo "Updated ${BRANCH} to ${UPSTREAM_REPO} ${upstream:0:7}. Cloudflare builds and deploys it in a minute or two."
