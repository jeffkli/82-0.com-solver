# Test strategy

The extension has four test layers:

1. `test_solver_core.js` — scoring math, known 82-0 fixture, and regression coverage for the upstream Standard/Adjusted solver API.
2. `test_probability_core.js` — initializes all 10,626 playable entries / 180 roll pools and exercises a deterministic low-sample AI decision.
3. `e2e_ui.py` — launches Chromium, executes the **production** content script/CSS/solver/probability code against a Next.js-style DOM fixture, and exercises first-roll detection, AI recommendations, roster state, a second in-place roll, skip mode, and AI failure fallback.
4. `e2e_extension.py` — loads a temporary localhost-enabled copy as a **real unpacked MV3 extension** in Playwright Chromium and verifies content-script ↔ service-worker integration.

Run the portable suite with `./tests/run.sh`.

The unpacked-extension test requires Playwright Chromium. Some managed environments disable unpacked extension loading by policy; GitHub Actions installs Playwright Chromium and runs this layer.
