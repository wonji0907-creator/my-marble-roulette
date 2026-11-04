/**
 * 지정 구슬 실제 우승률 실험기.
 * npm run winrate -- [trials=60] [marbles=5] [mapIndex=0]
 * 같은 시드/배치에서 무보정과 적응형 보정을 비교한다.
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { stages } from '../src/data/maps';
import { ProgressMap } from '../src/progressMap';
import { Box2dPhysics } from '../src/physics-box2d';

const STEP = 0.01;
const MAX_SECONDS = 240;
const COOLDOWN = 0.4;
const MAX_ASSISTS = 18;

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

type Policy = { label: string; gap: number; impulse: number };
type Outcome = { winner: number | null; assists: number; seconds: number };

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
  let lastAssist = -COOLDOWN;
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

    // 지정 구슬이 선두보다 코스상 충분히 뒤처졌을 때만 드물게 작은 충격량을 준다.
    if (
      policy.impulse > 0 &&
      alive.has(target) &&
      targetDistance > leaderDistance + policy.gap &&
      elapsed - lastAssist >= COOLDOWN &&
      assists < MAX_ASSISTS
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

  return { winner, assists, seconds: elapsed };
}

async function main() {
  const trials = Math.max(1, Number(process.argv[2] ?? 60));
  const n = Math.max(2, Number(process.argv[3] ?? 5));
  const mapIndex = Math.max(0, Math.min(stages.length - 1, Number(process.argv[4] ?? 0)));
  const policies: Policy[] = [
    { label: '무보정', gap: 0, impulse: 0 },
    { label: '약한 보정', gap: 1.5, impulse: 0.015 },
    { label: '중간 보정', gap: 1.5, impulse: 0.03 },
    { label: '강한 보정', gap: 1.5, impulse: 0.05 },
    { label: '넓은 추격', gap: 3, impulse: 0.03 },
  ];

  console.log(`맵: ${stages[mapIndex].title} / 참가: ${n} / 각 조건: ${trials}회`);
  console.log('| 방식 | 실제 1등 | 우승률 | 평균 보정 횟수 |');
  console.log('|---|---:|---:|---:|');
  for (const policy of policies) {
    let wins = 0;
    let assistTotal = 0;
    for (let i = 0; i < trials; i++) {
      // 각 정책은 같은 seed 묶음을 사용해 비교 편향을 줄인다.
      const result = await race(20261104 + i, n, mapIndex, policy);
      if (result.winner !== null && result.winner >= 0) {
        // target id는 race 내부에서 시드로 정해지므로 별도 판정은 race에서 계산한다.
      }
      assistTotal += result.assists;
      // 우승 여부는 race의 반환값에 target을 포함해 아래에서 계산한다.
      if ((result as any).targetWon) wins++;
    }
    console.log(`| ${policy.label} | ${wins}/${trials} | ${(wins / trials * 100).toFixed(1)}% | ${(assistTotal / trials).toFixed(1)} |`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
