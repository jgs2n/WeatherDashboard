#!/bin/bash
# Usage: ./deploy.sh "Your commit message"
# Stages project files, commits, and pushes the current branch.
#
# Safe to run when there is nothing new to commit: it skips the commit and
# still pushes, so commits made by hand (or a merge) that never got pushed
# still reach GitHub instead of the script dying on "nothing to commit".

set -uo pipefail

MSG="${1:-}"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "HEAD" ]; then
    echo "ERROR: detached HEAD - check out a branch before deploying." >&2
    exit 1
fi

# The site is served from main. Pushing any other branch updates GitHub but
# does NOT change what is deployed - warn, but allow it on purpose.
if [ "$BRANCH" != "main" ]; then
    echo "WARNING: you are on '$BRANCH', not main."
    echo "         This pushes the branch to GitHub but does NOT update the site."
    echo "         To deploy: git checkout main && git merge --ff-only $BRANCH"
    read -rp "Push '$BRANCH' anyway? [y/N] " reply
    case "$reply" in
        [Yy]*) ;;
        *) echo "Aborted."; exit 1 ;;
    esac
fi

# -- Stage --------------------------------------------------------------------
# data/, reports/, *.log, __pycache__/ and config.yaml are excluded by
# .gitignore, so adding whole directories here is safe.
git add -u                                                   # modified tracked files
git add .gitignore deploy.sh serve.ps1 2>/dev/null
git add src css docs pwa icons lib 2>/dev/null               # lib/ holds vendored jsfive
git add index.html about.html sw.js CLAUDE.md 2>/dev/null
git add server.py cities_to_benchmark.html 2>/dev/null
git add weather_benchmark/*.py weather_benchmark/*.md 2>/dev/null
git add weather_benchmark/src weather_benchmark/collector_lib weather_benchmark/tests 2>/dev/null
git add weather_benchmark/requirements.txt weather_benchmark/collector_config.yaml 2>/dev/null
git add weather_benchmark/config.example.yaml weather_benchmark/viewer.html 2>/dev/null
git add weather_benchmark/run_collector.cmd weather_benchmark/setup_collector_task.ps1 2>/dev/null

# -- Commit -------------------------------------------------------------------
if git diff --cached --quiet; then
    echo "Nothing new to commit - pushing existing commits."
else
    echo "Staged for commit:"
    git diff --cached --name-status | sed 's/^/  /'
    echo
    if [ -z "$MSG" ]; then
        read -rp "Commit message: " MSG
    fi
    if [ -z "$MSG" ]; then
        echo "ERROR: empty commit message, nothing committed." >&2
        exit 1
    fi
    git commit -m "$MSG" || exit 1
fi

# -- Push ---------------------------------------------------------------------
# -u sets the upstream, so a brand-new branch pushes without extra arguments
# (plain `git push` fails on a branch that has never been pushed).
git push -u origin HEAD || exit 1

echo
echo "Pushed $BRANCH -> origin/$BRANCH"
git log --oneline -1
