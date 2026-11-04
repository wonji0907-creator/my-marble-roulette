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

type Policy = { label: string; mode: 'none' | 'target-speed' | 'rival-slow' | 'combined'; gap: number; targetFactor: number; rivalFactor: number; cooldown: number; maxAssists: number };
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
    // 실제 게임처럼 슬로우모션 구간에서는 물리 시간만 느리게 진행한다.
    const rankedNow = [...alive].map((id) => {
      const p = physics.getMarblePosition(id);
      return { id, d: progress.distanceAt(p.x, p.y), y: p.y };
    }).sort((a, b) => a.d - b.d);
    const leader = rankedNow[0];
    const rival = rankedNow[1];
    const intensity = (y: number) => Math.max(0, 1 - Math.abs(stage.zoomY - y) / 5);
    const focusY = leader && rival
      ? (intensity(rival.y) > intensity(leader.y) ? rival.y : leader.y)
      : leader?.y ?? 0;
    const slowMotion = !!leader && !!rival &&
      Math.abs(stage.zoomY - focusY) < 5 &&
      focusY > stage.zoomY - 6;
    const timeScale = slowMotion ? Math.max(0.2, Math.abs(stage.zoomY - focusY) / 5) : 1;
    physics.step(STEP * timeScale);
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

    const targetRank = rankedNow.findIndex((m) => m.id === target) + 1;
    const rankBehind = targetRank >= 2;
    const shouldTrigger = policy.mode !== 'none' && rankBehind;

    // 목표 구슬이 뒤처졌을 때만 속도 크기를 미세 조정한다.
    // 진행 방향(속도 벡터)은 유지하고, 실제 결승 통과 순서는 물리 시뮬레이션에 맡긴다.
    if (
      alive.has(target) &&
      shouldTrigger &&
      Number.isFinite(targetDistance) &&
      Number.isFinite(leaderDistance) &&
      targetDistance > leaderDistance + policy.gap &&
      elapsed - lastAssist >= policy.cooldown &&
      assists < policy.maxAssists
    ) {
      if (policy.mode === 'target-speed' || policy.mode === 'combined') {
        physics.adjustMarbleSpeed(target, policy.targetFactor);
      }
      if (policy.mode === 'rival-slow' || policy.mode === 'combined') {
        for (const id of alive) {
          if (id !== target) physics.adjustMarbleSpeed(id, policy.rivalFactor);
        }
      }
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
    { label: '무보정 기준', mode: 'none', gap: 0, targetFactor: 1, rivalFactor: 1, cooldown: 0, maxAssists: 0 },
    { label: 'A 목표 구슬 +1.5%', mode: 'target-speed', gap: 1.0, targetFactor: 1.015, rivalFactor: 1, cooldown: 0.5, maxAssists: 16 },
    { label: 'B 경쟁 구슬 -1%', mode: 'rival-slow', gap: 1.0, targetFactor: 1, rivalFactor: 0.99, cooldown: 0.5, maxAssists: 16 },
    { label: 'C 두 방식 결합', mode: 'combined', gap: 1.0, targetFactor: 1.015, rivalFactor: 0.99, cooldown: 0.5, maxAssists: 16 },
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
