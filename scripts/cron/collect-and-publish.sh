#!/usr/bin/env bash

# Run the trusted collectors in a dedicated checkout and publish only the
# generated public snapshots. Private review data lives in AEROEVENTS_STATE_DIR
# and is never staged by this script.

set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_dir="$(cd -- "${script_dir}/../.." && pwd -P)"
if [[ -n "${AEROEVENTS_STATE_DIR:-}" ]]; then
  state_dir="${AEROEVENTS_STATE_DIR}"
elif [[ -n "${XDG_STATE_HOME:-}" ]]; then
  state_dir="${XDG_STATE_HOME}/aeroevents"
else
  state_dir="${HOME}/.local/state/aeroevents"
fi
lock_dir="${state_dir}/locks"
lock_file="${lock_dir}/collect-and-publish.lock"

case "${state_dir}" in
  /*) ;;
  *)
    echo "AEROEVENTS_STATE_DIR must be an absolute path: ${state_dir}" >&2
    exit 64
    ;;
esac

case "$(realpath -m -- "${state_dir}")/" in
  "$(realpath -m -- "${repo_dir}")/"*)
    echo "AEROEVENTS_STATE_DIR must be outside the repository: ${state_dir}" >&2
    exit 64
    ;;
esac

mkdir -p -- "${lock_dir}"

if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required to prevent overlapping collection runs." >&2
  exit 69
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "GNU timeout is required to bound a complete collection run." >&2
  exit 69
fi

exec 9>"${lock_file}"
if ! flock -n 9; then
  echo "Another collection run is active; leaving without changes." >&2
  exit 75
fi

cd -- "${repo_dir}"

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "The dedicated checkout is not clean; refusing to publish." >&2
  git status --short >&2
  exit 65
fi

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
if [[ -z "${upstream}" ]]; then
  echo "The current branch has no upstream; configure one before enabling cron." >&2
  exit 65
fi

git pull --ff-only

# Collection replaces a source snapshot only after the complete result has
# passed shared schema validation. Review candidates remain in state_dir.
timeout --foreground --signal=TERM --kill-after=30s 20m npm run events -- collect
npm run data:validate

allowed_paths=(
  "data/imported"
  "data/source-status.json"
)

existing_allowed=()
for candidate in "${allowed_paths[@]}"; do
  if [[ -e "${candidate}" ]]; then
    existing_allowed+=("${candidate}")
  fi
done

if ((${#existing_allowed[@]})); then
  git add -- "${existing_allowed[@]}"
fi

unexpected_staged="$(
  git diff --cached --name-only --diff-filter=ACMR \
    | awk '
      $0 == "data/source-status.json" { next }
      index($0, "data/imported/") == 1 { next }
      { print }
    '
)"
if [[ -n "${unexpected_staged}" ]]; then
  echo "Refusing to commit files outside the generated public-data allowlist:" >&2
  echo "${unexpected_staged}" >&2
  exit 65
fi

git diff --cached --check
if git diff --cached --quiet; then
  echo "Collection completed; there are no public data changes."
  exit 0
fi

verified_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
git commit -m "data: update event sources ${verified_at}"
git push
