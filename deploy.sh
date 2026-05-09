#!/bin/bash
# Usage: ./deploy.sh "Your commit message"
# Stages all project files, commits, and pushes.

MSG="${1}"
if [ -z "$MSG" ]; then
    read -rp "Commit message: " MSG
fi

git add -u                        # all modified tracked files
git add src/**/*.js 2>/dev/null   # any new/untracked JS in src/
git add css/ docs/ pwa/ icons/ 2>/dev/null
git add index.html about.html sw.js CLAUDE.md deploy.sh serve.ps1 2>/dev/null
git add weather_benchmark/CLAUDE.md weather_benchmark/src/*.py weather_benchmark/backtest.py server.py cities_to_benchmark.html 2>/dev/null

git commit -m "$MSG"
git push
