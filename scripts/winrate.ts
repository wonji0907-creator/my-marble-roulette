/**
 * 지정 구슬 실제 우승률 실험기.
 * npm run winrate -- [trials=100] [marbles=5]
 * 모든 정책은 동일한 시드 목록으로 비교한다.
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { stages } from '../src/data/maps';
import { ProgressMap } from '../src/progressMap';
import { Box2dPhysics } from '../src/physics-box2d';

const STEP = 0.01;
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

type Policy = { label: string; gap: number; impulse: number; cooldown: number; maxAssists: number };
type Outcome = { winner: number | null; targetWon: boolean; assists: number; seconds: number };

async function race(seed: number, n: number, mapIndex: number, policy: Policy): Promise<Outcome> {
  seedRandom(seed);
  const stage = stages[mapIndex];
  const progress = ProgressMap.for(stage);
  const physics = new NodePhysics();
  await physics.init();
  physics.createStage(stage);

  const rows = Math.ceil(n / 10);
  const lineDelta = -Math.max(0, Math.ceil(rows - 5));
  for (let id = 0; id < n; id++) {
    const line = Math.floor(id / 10);
    physics.createMarble(id, 10.25 + (id % 10) * 0.6, rows - line + lineDelta);
  }
  const target = Math.floor(Math.random() * n);
  physics.start();

  const alive = new Set(Array.from({ length: n }, (_, i) => i));
  const removals: { id: number; time: number }[] = [];
  let elapsed = 0;
  let lastAssist = -policy.cooldown;
  let assists = 0;
  let winner: number | null = null;

  while (alive.size && elapsed < MAX_SECONDS) {
    physics.step(STEP);
    elapsed += STEP;

    while (removals.length && removals[0].time <= elapsed) {
      physics.removeMarble(removals.shift()!.id);
    }

    let targetDistance = Infinity;
    let leaderDistance = Infinity;
    for (const id of alive) {
      const p = physics.getMarblePosition(id);
      if (p.y > stage.goalY) continue;
      const d = progress.distanceAt(p.x, p.y);
      if (id === target) targetDistance = d;
      else leaderDistance = Math.min(leaderDistance, d);
    }

    // 진행도 차이가 임계값을 넘을 때만 작은 충격량을 주며, 속도나 결승 결과는 강제하지 않는다.
    if (
      policy.impulse > 0 &&
      alive.has(target) &&
      Number.isFinite(targetDistance) &&
      Number.isFinite(leaderDistance) &&
      targetDistance > leaderDistance + policy.gap &&
      elapsed - lastAssist >= policy.cooldown &&
      assists < policy.maxAssists
    ) {
      physics.boostMarble(target, policy.impulse);
      lastAssist = elapsed;
      assists++;
    }

    for (const id of [...alive]) {
      const p = physics.getMarblePosition(id);
      if (p.y > stage.goalY) {
        if (winner === null) winner = id;
        alive.delete(id);
        removals.push({ id, time: elapsed + 0.5 });
      }
    }
    removals.sort((a, b) => a.time - b.time);
  }

  return { winner, targetWon: winner === target, assists, seconds: elapsed };
}

async function main() {
  const trials = Math.max(1, Number(process.argv[2] ?? 100));
  const n = Math.max(2, Number(process.argv[3] ?? 5));
  const mapIndex = 0; // Wheel of fortune 전용 실험
  const policies: Policy[] = [
    { label: '무보정 기준', gap: 0, impulse: 0, cooldown: 0, maxAssists: 0 },
    { label: '기존 최상위(다빈도)', gap: 1.5, impulse: 0.2, cooldown: 0.3, maxAssists: 24 },
    { label: '약한 충격·최대 8회', gap: 1.5, impulse: 0.1, cooldown: 0.8, maxAssists: 8 },
    { label: '중간 충격·최대 4회', gap: 1.5, impulse: 0.2, cooldown: 0.8, maxAssists: 4 },
    { label: '중간 충격·최대 8회', gap: 1.5, impulse: 0.2, cooldown: 0.8, maxAssists: 8 },
    { label: '중간 충격·최대 12회', gap: 1.5, impulse: 0.2, cooldown: 0.8, maxAssists: 12 },
    { label: '중간 충격·긴 간격', gap: 1.5, impulse: 0.2, cooldown: 1.5, maxAssists: 8 },
    { label: '조금 늦게 개입', gap: 2.0, impulse: 0.2, cooldown: 0.8, maxAssists: 8 },
    { label: '일찍 개입·소량', gap: 1.0, impulse: 0.1, cooldown: 0.8, maxAssists: 8 },
  ];

  console.log(`맵: ${stages[mapIndex].title} / 참가: ${n} / 조건별 반복: ${trials}`);
  console.log('| 보정 방식 | 1등 횟수 | 우승률 | 평균 보정 횟수 | 평균 완주시간 |');
  console.log('|---|---:|---:|---:|---:|');

  for (const policy of policies) {
    let wins = 0;
    let assistTotal = 0;
    let timeTotal = 0;
    for (let i = 0; i < trials; i++) {
      const result = await race(20261104 + i, n, mapIndex, policy);
      if (result.targetWon) wins++;
      assistTotal += result.assists;
      timeTotal += result.seconds;
    }
    console.log(
      `| ${policy.label} | ${wins}/${trials} | ${(wins / trials * 100).toFixed(1)}% | ${(assistTotal / trials).toFixed(1)} | ${(timeTotal / trials).toFixed(1)}s |`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
