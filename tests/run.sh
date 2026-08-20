#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node --check solver-core.js
node --check probability-core.js
node --check background.js
node --check content.js
node --check popup.js
node tests/test_solver_core.js
node tests/test_probability_core.js
node tests/test_background_integration.js
xvfb-run -a python tests/e2e_ui.py
