#!/bin/bash
# Usage: ./deploy.sh "Your commit message"
# Stages all project files, commits, and pushes.

MSG="${1}"
if [ -z "$MSG" ]; then
    read -rp "Commit message: " MSG
fi

git add -u                              # all modified tracked files
git add src/**/*.js 2>/dev/null         # any new/untracked JS in src/
git add css/ docs/ pwa/ icons/ lib/ 2>/dev/null   # lib/ holds vendored jsfive (required by lightning.js)
git add index.html about.html sw.js CLAUDE.md deploy.sh serve.ps1 2>/dev/null
git add server.py cities_to_benchmark.html 2>/dev/null

# weather_benchmark: ship code + docs + template configs, but NOT local data/reports/config.yaml
git add weather_benchmark/CLAUDE.md weather_benchmark/COLLECTOR.md weather_benchmark/README.md 2>/dev/null
git add weather_benchmark/requirements.txt weather_benchmark/collector_config.yaml 2>/dev/null
git add weather_benchmark/config.example.yaml weather_benchmark/viewer.html 2>/dev/null
git add weather_benchmark/*.py weather_benchmark/src/*.py 2>/dev/null
git add weather_benchmark/collector_lib/*.py weather_benchmark/tests/*.py 2>/dev/null
git add weather_benchmark/src/mesonet_observations.py 2>/dev/null
git add weather_benchmark/src/mrms_observations.py 2>/dev/null

git commit -m "$MSG"
git push
