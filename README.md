# 82-0 AI Draft Helper

A local fork of [`suryavjay/82-0.com-solver`](https://github.com/suryavjay/82-0.com-solver)
that adds projected **82-0 path probabilities** to the Chrome extension.

## What changed

- **Classic scoring only** for AI odds. The game-winning formula is evaluated exactly, including the
  positive-only STL/BPG normalization.
- Each legal **player + position** action is scored by:
  - standalone Classic OVR contribution;
  - exact marginal OVR to the current roster;
  - projected probability that the remaining random team-era rolls admit an 82-0 completion.
- The default decision model is **No skips**.
- Optional **Compare skips** mode adds:
  - `Team skip` projected odds;
  - `Decade skip` projected odds.
- The roll model enforces the observed rule that the same exact `team|era` cannot be an accepted roll
  more than **twice** in a five-pick game.
- The overlay automatically marks useful traps such as:
  - **OVR #1 · PPG #N** when the best Classic player in a roll is not its top scorer;
  - **low-PPG sleeper** for strong low-scoring contributors.
- Full `players_flat.json` snapshot is bundled as an offline fallback; the extension still fetches the
  current Firebase list at runtime.

## What the percentage means

`≈ 6.3% 82-0` means:

> Given this pick now, approximately 6.3% of sampled legal future roll sequences contain at least one
> legal completion that reaches 82 wins.

The future completion search is an **oracle-path / solvability estimate**: within each sampled future
sequence, the solver optimizes the remaining player choices with knowledge of that sampled sequence.
That is the same framing as the exhaustive “what fraction of five-roll sets are solvable?” analysis.

It is therefore best interpreted as a **decision-ranking upper bound**, not a claim that a causal human
who cannot see future rolls will literally win at that rate.

When only one future roll remains, the extension enumerates every legal next team-era exactly instead
of Monte Carlo sampling.

## Skip-mode caveat

`Compare skips` answers a useful immediate question:

- take Player A now, then assume no skips;
- use the team skip **now**, then optimize the rerolled current pool and future rolls;
- use the decade skip **now**, then optimize the rerolled current pool and future rolls.

The v1 skip comparison does **not** recursively value saving the other skip for a later round. Since the
default use case for this fork is no-skip play, the no-skip estimates are the primary model.

## Install

No npm/build step is required.

1. Download/unzip this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the folder containing `manifest.json`.
6. Open `https://www.82-0.com/`.
7. The `82-0 AI Helper` panel appears in the top-right.

The helper roster is tracked independently from the game page. After you make a pick on 82-0.com,
click **Add** on the same recommendation in the helper so the next-round probability is conditioned on
your actual roster.

## Settings

Click the extension toolbar icon:

- **No skips** — default; does not show or model team/decade skips.
- **Compare skips** — shows immediate team/decade skip odds.
- **Monte Carlo scenarios** — 50–1200. `200` is the default; the solver uses a small beam so the overlay stays responsive.
- **Skip availability** — manually mark a skip used/unused in Compare-skips mode.

## Files

- `solver-core.js` — preserves the upstream Standard/Adjusted API and adds exact Classic AI helpers.
- `probability-core.js` — Monte Carlo + beam-search solvability engine; runs behind the service worker.
- `content.js` / `content.css` — live 82-0.com overlay.
- `popup.html` / `popup.js` — AI settings.
- `background.js` — upstream-style Firebase fetch/cache plus isolated AI solving.
- `data/players.js` — bundled player snapshot.
- `index.html` — preserved standalone upstream solver.
- `tests/` — solver regression, probability, background integration, Chromium UI E2E, and true unpacked-extension E2E.

## Reliability / regression design

The AI layer is deliberately **non-fatal**. The original helper UI renders current-OVR recommendations first; probability solving happens through the extension service worker. If the service worker sleeps, crashes, or the AI solver throws, the panel stays mounted and switches to an **OVR-only fallback** instead of taking the extension down.

The fork also preserves the upstream Standard/Adjusted solver functions (`calculateAdjustedOvr`, `playerOvr`, `rankPool`, `expectedValuePick`, etc.). AI-specific duplicate-human handling is exposed separately through `humanKey` so it does not silently redefine the upstream `playerKey` behavior.

## Testing

Run the portable regression suite:

```bash
./tests/run.sh
```

It checks the known 118.4-OVR 82-0 fixture, upstream solver API compatibility, the 10,626-player/180-pool probability engine, background message integration, and a Chromium user-flow test covering roll detection, Add/remove behavior, a second in-place roll, skip mode, and forced AI failure fallback.

A stronger `tests/e2e_extension.py` test loads a temporary localhost-enabled copy as a **real unpacked MV3 extension** in Playwright Chromium and verifies the content-script/service-worker path. GitHub Actions installs Playwright Chromium and runs both E2E layers.

## Model details

Classic team OVR:

```text
100 * (
  totalPPG / 133.4 * 0.46 +
  totalRPG / 39.7  * 0.25 +
  totalAPG / 29.3  * 0.18 +
  adjustedSPG / 6.1 * 0.07 +
  adjustedBPG / 3.2 * 0.04
)
```

Defensive normalization:

```text
adjustedStat = sum(values > 0) * 5 / count(values > 0)
```

Wins:

```text
round(82 * min(OVR / 110, 1) ^ 1.15)
```

The displayed OVR required to round to 82 wins is `109.5`.

## Attribution

This fork keeps the basic extension architecture and live player-data source from
`suryavjay/82-0.com-solver`. The probability engine and max-2 roll model were added for this fork.
