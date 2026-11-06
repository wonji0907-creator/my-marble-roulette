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

type Policy = { label: string; mode: 'none' | 'target-speed' | 'leader-slow' | 'combined'; gap: number; targetFactor: number; rivalFactor: number; cooldown: number; maxAssists: number; startImpulse: number };
type Outcome = { first: boolean; second: boolean; assists: number; slowdowns: number; seconds: number };

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
  const target = 0; // 실제 입력 순서 첫 번째 참가자
  physics.start();
  // 시작 개입은 테스트 정책에서만 실행. 양의 Y 방향은 이 맵의 목표 방향이다.
  if (policy.startImpulse > 0) physics.boostMarble(target, policy.startImpulse);

  const alive = new Set(Array.from({ length: n }, (_, i) => i));
  const removals: { id: number; time: number }[] = [];
  let elapsed = 0;
  let lastAssist = -policy.cooldown;
  let assists = 0;
  let slowdowns = 0;
  const slowdownCounts = new Map<number, number>();
  const finishOrder: number[] = [];

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

    const intervalReady = elapsed - lastAssist >= policy.cooldown;
    if (alive.has(target) && policy.mode !== 'none' && intervalReady) {
      if (Number.isFinite(targetDistance) && Number.isFinite(leaderDistance) &&
          targetDistance > leaderDistance + policy.gap && assists < policy.maxAssists) {
        physics.adjustMarbleSpeed(target, policy.targetFactor);
        assists++;
        lastAssist = elapsed;
      }

      // 실제 게임처럼 첫 참가자를 제외한 모든 구슬을 구슬별 최대 8회 감속한다.
      for (const id of alive) {
        if (id === target) continue;
        const count = slowdownCounts.get(id) ?? 0;
        if (count >= 8) continue;
        physics.adjustMarbleSpeed(id, policy.rivalFactor);
        slowdownCounts.set(id, count + 1);
        slowdowns++;
        lastAssist = elapsed;
      }
    }

    for (const id of [...alive]) {
      const p = physics.getMarblePosition(id);
      if (p.y > stage.goalY) {
        finishOrder.push(id);
        alive.delete(id);
        removals.push({ id, time: elapsed + 0.5 });
      }
    }
    removals.sort((a, b) => a.time - b.time);
  }

  return { first: finishOrder[0] === target, second: finishOrder[1] === target, assists, slowdowns, seconds: elapsed };
}

async function main() {
  const trials = Math.max(1, Number(process.argv[2] ?? 100));
  const n = Math.max(2, Number(process.argv[3] ?? 5));
  const mapIndex = 0; // Wheel of fortune 전용 실험
  const policies: Policy[] = [
    { label: '첫 입력 구슬 가속 + 나머지 전원 감속', mode: 'combined', gap: 0.25, targetFactor: 1.25, rivalFactor: 0.95, cooldown: 0.25, maxAssists: 32, startImpulse: 0 },
  ];

  console.log(`맵: ${stages[mapIndex].title} / 참가: ${n} / 조건별 반복: ${trials}`);
  console.log('| 보정 방식 | 1등 | 2등 | 평균 가속 | 평균 감속 | 평균 완주시간 |');
  console.log('|---|---:|---:|---:|---:|---:|');

  for (const policy of policies) {
    let firstCount = 0;
    let secondCount = 0;
    let assistTotal = 0;
    let slowdownTotal = 0;
    let timeTotal = 0;
    for (let i = 0; i < trials; i++) {
      const result = await race(20261104 + i, n, mapIndex, policy);
      if (result.first) firstCount++;
      if (result.second) secondCount++;
      assistTotal += result.assists;
      slowdownTotal += result.slowdowns;
      timeTotal += result.seconds;
    }
    console.log(
      `| ${policy.label} | ${firstCount}/${trials} (${(firstCount / trials * 100).toFixed(1)}%) | ${secondCount}/${trials} (${(secondCount / trials * 100).toFixed(1)}%) | ${(assistTotal / trials).toFixed(1)} | ${(slowdownTotal / trials).toFixed(1)} | ${(timeTotal / trials).toFixed(1)}s |`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
