# 82-0 Draft Helper

A pick recommender for the NBA draft game at [82-0.com](https://www.82-0.com).
You draft one player per position (PG, SG, SF, PF, C); each round rolls a random
team + decade and you choose from that pool. The goal is to push the team's
overall rating high enough to win all 82 games. This tool ranks the available
players by how much they move that rating and keeps a running roster total.

It ships two ways: a Chrome extension that overlays recommendations directly on
the game, and a standalone `index.html` page for planning rolls by hand.

## Install (unpacked extension)

1. Clone or download this folder.
2. Optional: paste your real player list into `data/players.js` (see format
   below). The extension pulls the live list from Firebase at runtime, so this
   only matters as an offline fallback and for the standalone page.
3. Open `chrome://extensions`, turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Open [82-0.com](https://www.82-0.com) and play — a panel appears in the
   top-right corner.

## Using the overlay

- The panel reads the current team/era roll off the page and lists the top 3
  picks for it, each showing the resulting team OVR and projected wins.
- **Add** drops a pick into your roster; the summary at the bottom tracks total
  OVR, projected wins, and the letter grade.
- If even the best available player barely moves the needle, the panel suggests
  using a skip.
- Drag the header to move the panel; the **–** button hides it (a small button
  brings it back).

If roll detection ever misses, set `CONFIG.rollSelector` near the top of
`content.js` to a selector for the element that shows the team/era.

## Popup settings

Click the extension's toolbar icon for a small settings popup — no file edits
needed:

- **Scoring mode** — toggle between **Adjusted** (the default) and **Raw**
  (standard). The overlay updates live.
- **Skip threshold** — the score below which the panel recommends a skip.
- **Reload player data** — forces a fresh pull from Firebase, refreshes the
  cache, and tells any open game tab to re-read the list.

Settings are stored in `chrome.storage.local`; the content script watches that
key, so changes apply immediately without a reload.

## Standalone page

Open `index.html` in a browser (or serve the folder with any static server so
the live data fetch isn't blocked). Pick a team and era from the dropdowns to
see the ranked pool, and build a roster slot by slot to watch the totals.

## Standard vs Adjusted

- **Standard** — the team rating that actually decides the game. Each category
  (points, rebounds, assists, steals, blocks) is summed across the roster,
  divided by a fixed "perfect team" denominator, and blended with category
  weights. Steals and blocks are averaged over the players who post them before
  being scaled to a full lineup.
- **Adjusted** (default) — an era-aware view that grades each player against the
  baselines for their decade and the weights for their position, with a small
  bonus for a set of legacy players. Match this to whichever mode the game is
  set to; flip to Raw in the popup if you're playing standard.

## Player data format

`data/players.js` assigns an array to `self.PLAYERS`. To swap in the real list,
copy the array out of your `players_flat.json` and paste it between the
brackets, keeping the `self.PLAYERS =` prefix and trailing `;`. Each entry looks
like:

```js
{
  "player": "Shaquille O'Neal",
  "team": "LAL",
  "era": "2000s",
  "ppg": 27.0, "rpg": 12.0, "apg": 3.0, "spg": 0.5, "bpg": 2.5,
  "positions": ["C"]
}
```

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 definition |
| `solver-core.js` | Scoring formulas and the pick recommenders |
| `content.js` | Reads the roll, renders the on-page panel |
| `popup.html` / `popup.js` | Toolbar settings: mode, skip threshold, data reload |
| `background.js` | Service worker; fetches and caches player data |
| `index.html` | Standalone planner (loads `data/players.js` directly) |
| `data/players.js` | Player list — standalone data + extension offline fallback |

## Notes

The standard scoring formula, weights, and win curve were reconstructed by
reading the game's own client-side code. The adjusted-mode blend is a
best-effort reconstruction and is kept separate from the standard path. No
player data is bundled beyond a small sample — drop in the full list yourself.
