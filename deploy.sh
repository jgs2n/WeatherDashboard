#!/bin/bash
# Usage: ./deploy.sh "Your commit message"
# Stages all tracked changes + any new project files, commits, and pushes.

MSG="${1}"
if [ -z "$MSG" ]; then
    read -rp "Commit message: " MSG
fi

git add -u                        # all modified tracked files
git add about.html 2>/dev/null    # new files (silently skips if already tracked)
git add src/services/nowcast.js src/services/observations.js src/services/radarSampler.js src/utils/metarParse.js 2>/dev/null
git add CLAUDE.md REFACTOR_PLAN.md deploy.sh serve.ps1 2>/dev/null

git commit -m "$MSG"
git push
