/**
 * Baseline physics telemetry for Wheel of fortune.
 * Read-only instrumentation: no impulses, velocity changes, or outcome manipulation.
 * Usage: npm run diagnose -- [trials=300] [marbles=5]
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { stages } from '../src/data/maps';
import { ProgressMap } from '../src/progressMap';
import { Box2dPhysics } from '../src/physics-box2d';

const STEP = 0.01;
const SAMPLE_EVERY = 5;
const MAX_SECONDS = 240;

function seedRandom(seed: number) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class NodePhysics extends Box2dPhysics {
  async init(): Promise<void> {
    const wasmBinary = fs.readFileSync(new URL('../node_modules/box2d-wasm/dist/umd/Box2D.simd.wasm', import.meta.url));
    const self = this as any;
    self.Box2D = await Box2DFactory({ wasmBinary } as any);
    self.gravity = new self.Box2D.b2Vec2(0, 10);
    self.world = new self.Box2D.b2World(self.gravity);
  }
}

type Metrics = {
  samples: number; speedSum: number; minSpeed: number; slowSamples: number;
  contactSamples: number; contactStarts: number; sharpDrops: number; reversals: number;
  distanceSum: number; xSum: number; ySum: number;
};
type Snapshot = { speed: number; vx: number; vy: number; touching: boolean; distance: number; x: number; y: number };

function freshMetrics(): Metrics {
  return { samples: 0, speedSum: 0, minSpeed: Infinity, slowSamples: 0, contactSamples: 0,
    contactStarts: 0, sharpDrops: 0, reversals: 0, distanceSum: 0, xSum: 0, ySum: 0 };
}

function addSample(m: Metrics, s: Snapshot, prev?: Snapshot) {
  m.samples++;
  m.speedSum += s.speed;
  m.minSpeed = Math.min(m.minSpeed, s.speed);
  if (s.speed < 1) m.slowSamples++;
  if (s.touching) m.contactSamples++;
  if (s.touching && !prev?.touching) m.contactStarts++;
  if (prev && prev.speed > 0.8 && s.speed < prev.speed * 0.7) m.sharpDrops++;
  if (prev && prev.vx * s.vx + prev.vy * s.vy < 0) m.reversals++;
  m.distanceSum += s.distance;
  m.xSum += s.x;
  m.ySum += s.y;
}

function report(label: string, m: Metrics) {
  const n = Math.max(1, m.samples);
  return {
    group: label, samples: m.samples,
    meanSpeed: +(m.speedSum / n).toFixed(3),
    minObservedSpeed: Number.isFinite(m.minSpeed) ? +m.minSpeed.toFixed(3) : null,
    slowTimePct: +(m.slowSamples / n * 100).toFixed(2),
    contactTimePct: +(m.contactSamples / n * 100).toFixed(2),
    contactStarts: m.contactStarts, sharpSpeedDrops: m.sharpDrops, directionReversals: m.reversals,
    meanProgressDistance: +(m.distanceSum / n).toFixed(3),
    meanX: +(m.xSum / n).toFixed(3), meanY: +(m.ySum / n).toFixed(3),
  };
}

async function runRace(seed: number, n: number) {
  seedRandom(seed);
  const stage = stages[0];
  const progress = ProgressMap.for(stage);
  const physics = new NodePhysics();
  await physics.init();
  physics.createStage(stage);
  const rows = Math.ceil(n / 10);
  const lineDelta = -Math.max(0, Math.ceil(rows - 5));
  for (let id = 0; id < n; id++) physics.createMarble(id, 10.25 + (id % 10) * 0.6, rows - Math.floor(id / 10) + lineDelta);
  const target = Math.floor(Math.random() * n);
  physics.start();

  const alive = new Set(Array.from({ length: n }, (_, i) => i));
  const removals: { id: number; time: number }[] = [];
  const metrics = Array.from({ length: n }, freshMetrics);
  const previous = new Map<number, Snapshot>();
  let elapsed = 0;
  let winner: number | null = null;

  while (alive.size && elapsed < MAX_SECONDS) {
    const ranked = [...alive].map(id => {
      const p = physics.getMarblePosition(id);
      return { id, d: progress.distanceAt(p.x, p.y), y: p.y };
    }).sort((a,b) => a.d - b.d);
    const leader = ranked[0];
    const rival = ranked[1];
    const intensity = (y: number) => Math.max(0, 1 - Math.abs(stage.zoomY - y) / 5);
    const focusY = leader && rival && intensity(rival.y) > intensity(leader.y) ? rival.y : leader?.y ?? 0;
    const slowMotion = !!leader && !!rival && Math.abs(stage.zoomY - focusY) < 5 && focusY > stage.zoomY - 6;
    const timeScale = slowMotion ? Math.max(0.2, Math.abs(stage.zoomY - focusY) / 5) : 1;
    physics.step(STEP * timeScale);
    elapsed += STEP;

    while (removals.length && removals[0].time <= elapsed) physics.removeMarble(removals.shift()!.id);

    if (Math.round(elapsed / STEP) % SAMPLE_EVERY === 0) {
      for (const id of alive) {
        const t = physics.getMarbleTelemetry(id);
        if (!t) continue;
        const s: Snapshot = { ...t, distance: progress.distanceAt(t.x, t.y) };
        addSample(metrics[id], s, previous.get(id));
        previous.set(id, s);
      }
    }

    for (const id of [...alive]) {
      const p = physics.getMarblePosition(id);
      if (p.y > stage.goalY) {
        if (winner === null) winner = id;
        alive.delete(id);
        removals.push({ id, time: elapsed + 0.5 });
      }
    }
    removals.sort((a,b) => a.time - b.time);
  }
  return { target, winner, metrics, seconds: elapsed };
}

async function main() {
  const trials = Math.max(1, Number(process.argv[2] ?? 300));
  const n = Math.max(2, Number(process.argv[3] ?? 5));
  const groups = { targetWins: freshMetrics(), targetLosses: freshMetrics(), otherWinners: freshMetrics(), otherMarbles: freshMetrics() };
  let targetWins = 0;
  let completed = 0;
  const finishTimes: number[] = [];
  for (let i = 0; i < trials; i++) {
    const r = await runRace(20261104 + i, n);
    if (r.winner === null) continue;
    completed++;
    finishTimes.push(r.seconds);
    if (r.winner === r.target) targetWins++;
    for (let id = 0; id < n; id++) {
      const bucket = id === r.target
        ? (r.winner === r.target ? groups.targetWins : groups.targetLosses)
        : (id === r.winner ? groups.otherWinners : groups.otherMarbles);
      const source = r.metrics[id];
      for (const key of Object.keys(bucket) as (keyof Metrics)[]) bucket[key] += source[key];
    }
  }
  const result = {
    map: stages[0].title, marbles: n, requestedTrials: trials, completedTrials: completed,
    targetWinRate: +(targetWins / Math.max(1, completed) * 100).toFixed(2),
    meanFinishSeconds: +(finishTimes.reduce((a,b)=>a+b,0) / Math.max(1,finishTimes.length)).toFixed(2),
    telemetry: [
      report('selected marble wins', groups.targetWins),
      report('selected marble loses', groups.targetLosses),
      report('other marble wins', groups.otherWinners),
      report('other marbles lose', groups.otherMarbles),
    ],
    note: 'Read-only sampled telemetry. Contact is sampled every 0.05s, so brief contacts may be missed; this is not a causal intervention test.',
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
