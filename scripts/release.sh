#!/usr/bin/env bash
set -euo pipefail

# Automatic release script for phantom-build
# Reads git commits since the last tag and determines the version bump:
#   - BREAKING CHANGE or feat!: → major
#   - feat: → minor
#   - fix:, docs:, chore:, refactor:, test:, perf: → patch
#
# Usage:
#   ./scripts/release.sh          # auto-detect bump from commits
#   ./scripts/release.sh patch    # force a specific bump
#   ./scripts/release.sh minor
#   ./scripts/release.sh major
#   ./scripts/release.sh --dry-run  # show what would happen

DRY_RUN=false
FORCE_BUMP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    patch|minor|major) FORCE_BUMP="$arg" ;;
    *) echo "Usage: $0 [patch|minor|major] [--dry-run]"; exit 1 ;;
  esac
done

# Get the last tag (or use initial commit if no tags exist)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -z "$LAST_TAG" ]; then
  echo "No previous tags found. Using all commits."
  COMMITS=$(git log --pretty=format:"%s" --no-merges)
else
  echo "Last release: $LAST_TAG"
  COMMITS=$(git log "$LAST_TAG"..HEAD --pretty=format:"%s" --no-merges)
fi

if [ -z "$COMMITS" ]; then
  echo "No new commits since last release. Nothing to do."
  exit 0
fi

echo ""
echo "Commits since last release:"
echo "$COMMITS" | sed 's/^/  /'
echo ""

# Determine bump from commit messages
if [ -n "$FORCE_BUMP" ]; then
  BUMP="$FORCE_BUMP"
  echo "Forced bump: $BUMP"
else
  BUMP="patch"  # default

  while IFS= read -r msg; do
    # Check for breaking changes (highest priority)
    if echo "$msg" | grep -q '!:' || echo "$msg" | grep -q 'BREAKING CHANGE'; then
      BUMP="major"
      break
    fi
    # Check for new features
    if echo "$msg" | grep -q '^feat'; then
      BUMP="minor"
      # Don't break — keep checking for breaking changes
    fi
  done <<< "$COMMITS"

  echo "Auto-detected bump: $BUMP"
fi

# Show what we'll do
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "[DRY RUN] Would run: npm run release:$BUMP"
  echo "[DRY RUN] No changes made."
  exit 0
fi

echo ""
read -p "Proceed with $BUMP release? (y/N) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  npm run "release:$BUMP"
  echo ""
  echo "✓ Released successfully!"
else
  echo "Aborted."
  exit 0
fi
