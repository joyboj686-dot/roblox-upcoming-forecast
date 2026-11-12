// Roblox Up-and-Coming top-10 forecaster (Node, standard library only, deterministic, no network).
//
// Model: every game on the latest chart gets a "centre" rank (an exponentially time-weighted average of its recent
// ranks, plus a momentum term and a player-count term; games missing from earlier reads count as deep in the chart),
// and a rank distribution around that centre whose width is wide (the chart churns heavily over 72 h). For each place
// k a game's weight is that distribution's density at k; the weights are normalised across games per place so each
// place's named mass is M (< 1), keeping a small share unnamed for games that appear later. Nothing is hardcoded:
// everything is computed from history.ndjson at run time.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Params {
  halfLife: number; // hours, half-life of the rank EMA
  momentum: number; // multiple of (EMA rank - latest rank) added to the centre (>0 extrapolates the latest move)
  playW: number; // places gained per ln(playing / chart-median playing)
  missRank: number; // rank assumed for a game absent from a read
  sigma: number; // spread (in places) of the rank distribution
  sigmaFar: number; // extra spread per ln(1 + centre) so deep games are broader
  tail: number; // weight of the broad uniform tail inside each game's density
  mass: number; // named mass per place
  maxAgeDays: number;
  ageRampHours: number;
  slopeLag: number; // hours back for the slope reference read
  slopeW: number; // places added per place of rank change since the reference read (negative = fade the climb)
  playG: number; // places gained per ln growth in playing since the reference read
}

export const DEFAULTS: Params = {
  halfLife: 12,
  momentum: 1,
  playW: 0,
  missRank: 60,
  sigma: 2,
  sigmaFar: 2,
  tail: 0.4,
  mass: 0.9,
  maxAgeDays: 28,
  ageRampHours: 48,
  slopeLag: 24,
  slopeW: 0.3,
  playG: 1,
};

interface Row {
  rank: number;
  universe_id: number;
  playing: number | null;
}
interface Read {
  at: string;
  up_and_coming: Row[];
  details?: Record<string, { created?: string | null } | null> | null;
}
interface Task {
  places: number;
  window?: { from: string; until: string };
  history_until?: string;
}
export interface Forecast {
  probabilities: Array<{ universe_id: number; place: number; p: number }>;
  top10: number[];
}

export function forecast(reads: Read[], task: Task, P: Params = DEFAULTS): Forecast {
  const places = task.places ?? 10;
  const sorted = [...reads].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = sorted[sorted.length - 1]!;
  const tNow = Date.parse(last.at);
  const windowMid = task.window
    ? (Date.parse(task.window.from) + Date.parse(task.window.until)) / 2
    : tNow + 36 * 3600e3;
  const chart = [...last.up_and_coming].sort((a, b) => a.rank - b.rank);
  const n = chart.length;

  // time-weighted EMA of rank per game over the history (reads at least 1 h from "now" decay by half-life)
  const ids = chart.map((r) => r.universe_id);
  const num = new Map<number, number>();
  const den = new Map<number, number>();
  for (const id of ids) {
    num.set(id, 0);
    den.set(id, 0);
  }
  const lastPlaying = new Map<number, number>();
  const created = new Map<number, number>();
  for (const rd of sorted) {
    const w = Math.pow(0.5, (tNow - Date.parse(rd.at)) / 3600e3 / P.halfLife);
    const rk = new Map<number, number>();
    for (const r of rd.up_and_coming) rk.set(r.universe_id, r.rank);
    for (const id of ids) {
      const v = rk.get(id) ?? P.missRank;
      num.set(id, num.get(id)! + w * Math.min(v, P.missRank));
      den.set(id, den.get(id)! + w);
    }
    if (rd.details) {
      for (const id of ids) {
        const c = rd.details[String(id)]?.created;
        if (c) {
          const t = Date.parse(c);
          if (Number.isFinite(t)) created.set(id, t);
        }
      }
    }
  }
  const playing = chart.map((r) => r.playing).filter((x): x is number => typeof x === 'number' && x > 0).sort((a, b) => a - b);
  const medPlay = playing.length ? playing[Math.floor(playing.length / 2)]! : 1;

  const centres: number[] = [];
  const ageMul: number[] = [];
  // reference read about slopeLag hours before the latest one (nearest in time)
  let lagRead = sorted[0]!;
  for (const rd of sorted) {
    if (Math.abs(tNow - Date.parse(rd.at) - P.slopeLag * 3600e3) < Math.abs(tNow - Date.parse(lagRead.at) - P.slopeLag * 3600e3)) lagRead = rd;
  }
  const lagRank = new Map<number, number>();
  const lagPlay = new Map<number, number>();
  for (const r of lagRead.up_and_coming) {
    lagRank.set(r.universe_id, r.rank);
    if (typeof r.playing === 'number' && r.playing > 0) lagPlay.set(r.universe_id, r.playing);
  }
  chart.forEach((r) => {
    const ema = num.get(r.universe_id)! / den.get(r.universe_id)!;
    let c = ema + P.momentum * (r.rank - ema);
    const lr = lagRank.get(r.universe_id) ?? P.missRank;
    c += P.slopeW * (r.rank - Math.min(lr, P.missRank));
    if (typeof r.playing === 'number' && r.playing > 0) {
      if (P.playW) c -= P.playW * Math.log(r.playing / medPlay);
      const lp = lagPlay.get(r.universe_id);
      if (P.playG && lp) c -= P.playG * Math.log(r.playing / lp);
    }
    centres.push(Math.max(1, c));
    // age: games created > maxAge days before the window's middle will have left the chart
    let m = 1;
    const cr = created.get(r.universe_id);
    if (cr !== undefined) {
      const leaveAt = cr + P.maxAgeDays * 86400e3;
      const hoursToLeave = (leaveAt - tNow) / 3600e3;
      const horizonMid = (windowMid - tNow) / 3600e3;
      if (hoursToLeave <= 0) m = 0.02;
      else if (hoursToLeave < horizonMid + P.ageRampHours) m = Math.max(0.05, hoursToLeave / (horizonMid + P.ageRampHours));
    }
    ageMul.push(m);
  });

  const dens = (c: number, k: number, mul: number) => {
    const s = P.sigma + P.sigmaFar * Math.log(1 + c);
    const z = (k - c) / s;
    return mul * ((1 - P.tail) * Math.exp(-0.5 * z * z) / s + P.tail / n);
  };

  const probabilities: Forecast['probabilities'] = [];
  const named = Math.min(n, 100);
  const order = chart.map((_, i) => i).sort((a, b) => centres[a]! - centres[b]! || a - b);
  const cand = order.slice(0, named);
  for (let k = 1; k <= places; k++) {
    const w = cand.map((i) => dens(centres[i]!, k, ageMul[i]!));
    const tot = w.reduce((a, b) => a + b, 0);
    const floor = (1 - P.mass) / Math.max(n, 1);
    cand.forEach((i, j) => {
      const p = Math.max(floor, (P.mass * w[j]!) / tot);
      probabilities.push({ universe_id: chart[i]!.universe_id, place: k, p: Math.round(p * 1e6) / 1e6 });
    });
  }
  // keep each place's sum <= 1 after flooring/rounding
  for (let k = 1; k <= places; k++) {
    const rows = probabilities.filter((r) => r.place === k);
    const s = rows.reduce((a, r) => a + r.p, 0);
    if (s > 0.999) for (const r of rows) r.p = Math.floor((r.p * 0.999) / s * 1e6) / 1e6;
  }

  // top10: greedy assignment by place probability
  const top10: number[] = [];
  const used = new Set<number>();
  for (let k = 1; k <= places; k++) {
    let best = -1;
    let bp = -1;
    for (const r of probabilities) {
      if (r.place === k && !used.has(r.universe_id) && r.p > bp) {
        bp = r.p;
        best = r.universe_id;
      }
    }
    if (best >= 0) {
      used.add(best);
      top10.push(best);
    }
  }
  return { probabilities, top10 };
}

function main() {
  const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as Task & { output?: string };
  const reads = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Read);
  const out = forecast(reads, task);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, task.output ?? 'forecast.json'), JSON.stringify(out) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
