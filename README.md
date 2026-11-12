# Roblox Up-and-Coming Forecast

Entry for make.fun competition `roblox-up-and-coming-forecast-01`:
forecast Roblox's Up-and-Coming chart top 10, place by place, for the
72 hours after entries close (2026-11-13T06:00:00Z to 2026-11-16T06:00:00Z).

`main.ts` (Node 22, standard library only) reads the chart history in
`/input` (`history.ndjson` + `task.json`) and writes
`/output/forecast.json`: per-place probabilities for each game plus a
top-10 guess. It models each game's trajectory from the history —
player-count momentum, growth rate, rank velocity and climb duration —
and spreads probability honestly across the games most likely to hold
each place, rather than betting everything on the chart standing still.

Run locally:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

License: MIT.
