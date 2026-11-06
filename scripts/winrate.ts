/**
 * Wheel of fortune: 게임의 현재 추격 보정과 하단 도달 스킬 조건을 그대로 재현하는 실험기.
 * npm run winrate -- [trials=500] [marbles=5]
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

type Outcome = {
  first: boolean;
  second: boolean;
  skillTriggered: boolean;
  assists: number;
  slowdowns: number;
  seconds: number;
};

async function race(seed: number, n: number): Promise<Outcome> {
  seedRandom(seed);
  const stage = stages[0];
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

  const target = 0;
  physics.start();
  const alive = new Set(Array.from({ length: n }, (_, i) => i));
  const removals: { id: number; time: number }[] = [];
  const finishOrder: number[] = [];
  const slowdownCounts = new Map<number, number>();
  let elapsed = 0;
  let chaseElapsed = 0;
  let lastAssist = -Infinity;
  let assists = 0;
  let slowdowns = 0;
  let skillTriggered = false;

  while (alive.size && elapsed < MAX_SECONDS) {
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
    chaseElapsed += STEP * timeScale;

    while (removals.length && removals[0].time <= elapsed) {
      physics.removeMarble(removals.shift()!.id);
    }

    // 이번 스텝에서 결승선을 통과한 구슬을 먼저 기록한다.
    const crossed = [...alive].map((id) => {
      const p = physics.getMarblePosition(id);
      return { id, y: p.y, d: progress.distanceAt(p.x, p.y) };
    }).filter((m) => m.y > stage.goalY).sort((a, b) => a.d - b.d);
    for (const marble of crossed) {
      if (!finishOrder.includes(marble.id)) finishOrder.push(marble.id);
    }

    // 게임 코드와 동일: 지정 구슬이 1등이 아니고, 어느 구슬이든 goalY - 5에
    // 도달하면 지정 구슬에 Impact를 단 한 번 적용한다.
    if (!skillTriggered && alive.has(target)) {
      const positions = [...alive].map((id) => {
        const p = physics.getMarblePosition(id);
        return { id, x: p.x, y: p.y, d: progress.distanceAt(p.x, p.y) };
      });
      const bottomReached = positions.some((m) => m.y >= stage.goalY - 5);
      const designatedIsFirst = finishOrder.length > 0
        ? finishOrder[0] === target
        : positions.sort((a, b) => a.d - b.d)[0]?.id === target;

      if (bottomReached && !designatedIsFirst) {
        physics.impact(target);
        skillTriggered = true;
      }
    }

    // Wheel of fortune의 기존 추격 가속/상대 감속은 게임 코드의 수치와 주기를 유지한다.
    const intervalReady = chaseElapsed - lastAssist >= 0.25;
    if (alive.has(target) && intervalReady) {
      const current = [...alive].map((id) => {
        const p = physics.getMarblePosition(id);
        return { id, d: progress.distanceAt(p.x, p.y) };
      });
      const targetDistance = current.find((m) => m.id === target)?.d ?? Infinity;
      const leaderDistance = Math.min(...current.filter((m) => m.id !== target).map((m) => m.d));

      if (Number.isFinite(targetDistance) && Number.isFinite(leaderDistance) &&
          targetDistance > leaderDistance + 0.25 && assists < 32) {
        physics.adjustMarbleSpeed(target, 1.2);
        assists++;
        lastAssist = chaseElapsed;
      }

      for (const id of alive) {
        if (id === target) continue;
        const count = slowdownCounts.get(id) ?? 0;
        if (count >= 8) continue;
        physics.adjustMarbleSpeed(id, 0.95);
        slowdownCounts.set(id, count + 1);
        slowdowns++;
        lastAssist = chaseElapsed;
      }
    }

    for (const id of crossed.map((m) => m.id)) {
      alive.delete(id);
      removals.push({ id, time: elapsed + 0.5 });
    }
    removals.sort((a, b) => a.time - b.time);
  }

  return {
    first: finishOrder[0] === target,
    second: finishOrder[1] === target,
    skillTriggered,
    assists,
    slowdowns,
    seconds: elapsed,
  };
}

async function main() {
  const trials = Math.max(1, Number(process.argv[2] ?? 500));
  const n = Math.max(2, Number(process.argv[3] ?? 5));
  let firstCount = 0;
  let secondCount = 0;
  let skillCount = 0;
  let assistTotal = 0;
  let slowdownTotal = 0;
  let timeTotal = 0;
  let completed = 0;

  for (let i = 0; i < trials; i++) {
    const result = await race(20261106 + i, n);
    if (result.first || result.second) completed++;
    if (result.first) firstCount++;
    if (result.second) secondCount++;
    if (result.skillTriggered) skillCount++;
    assistTotal += result.assists;
    slowdownTotal += result.slowdowns;
    timeTotal += result.seconds;
  }

  console.log(`맵: ${stages[0].title} / 참가: ${n} / 반복: ${trials} / 완주 레이스: ${completed}`);
  console.log('| 항목 | 결과 |');
  console.log('|---|---:|');
  console.log(`| 지정 구슬 1등 | ${firstCount}/${trials} (${(firstCount / trials * 100).toFixed(1)}%) |`);
  console.log(`| 지정 구슬 2등 | ${secondCount}/${trials} (${(secondCount / trials * 100).toFixed(1)}%) |`);
  console.log(`| 하단 도달 스킬 발동 | ${skillCount}/${trials} (${(skillCount / trials * 100).toFixed(1)}%) |`);
  console.log(`| 평균 추격 가속 횟수 | ${(assistTotal / trials).toFixed(1)} |`);
  console.log(`| 평균 상대 감속 횟수 | ${(slowdownTotal / trials).toFixed(1)} |`);
  console.log(`| 평균 완주 시간 | ${(timeTotal / trials).toFixed(1)}s |`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
