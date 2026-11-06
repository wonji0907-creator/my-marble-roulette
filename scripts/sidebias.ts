/**
 * Wheel of fortune 마지막 회전 장애물 좌/우 통과 보정 가능성 실험.
 * npm run sidebias -- [trials=500] [marbles=5]
 * 같은 시드 집합으로 무보정, 오른쪽, 왼쪽 수평 충격량을 비교한다.
 * main 브랜치의 게임 로직은 변경하지 않는 진단용 실험이다.
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { stages } from '../src/data/maps';
import { ProgressMap } from '../src/progressMap';
import { Box2dPhysics } from '../src/physics-box2d';

const STEP = 0.01;
const MAX_SECONDS = 240;
const OBSTACLE_Y = 106.75;
const OBSTACLE_MID_X = 14;
const IMPULSE_Y = 104.5;

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

  applyHorizontalImpulse(id: number, impulse: number) {
    const self = this as any;
    const marble = self.marbleMap[id];
    if (!marble) return;
    marble.ApplyLinearImpulseToCenter(new self.Box2D.b2Vec2(impulse, 0), true);
  }
}

type Condition = { label: string; impulse: number };
type Outcome = { right: boolean; xAtCrossing: number; first: boolean; impulseApplied: boolean };

async function race(seed: number, n: number, condition: Condition): Promise<Outcome> {
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
  let lastAssist = -0.25;
  let assists = 0;
  let lastChanceSkillUsed = false;
  let impulseApplied = false;
  let previousTarget = physics.getMarblePosition(target);
  let xAtCrossing: number | null = null;

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

    while (removals.length && removals[0].time <= elapsed) {
      physics.removeMarble(removals.shift()!.id);
    }

    if (alive.has(target)) {
      const current = physics.getMarblePosition(target);

      if (!impulseApplied && condition.impulse !== 0 && current.y >= IMPULSE_Y && current.y < OBSTACLE_Y) {
        physics.applyHorizontalImpulse(target, condition.impulse);
        impulseApplied = true;
      }

      if (xAtCrossing === null && previousTarget.y < OBSTACLE_Y && current.y >= OBSTACLE_Y) {
        const dy = current.y - previousTarget.y;
        const ratio = dy > 0 ? (OBSTACLE_Y - previousTarget.y) / dy : 1;
        xAtCrossing = previousTarget.x + (current.x - previousTarget.x) * ratio;
      }
      previousTarget = current;
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

    if (!lastChanceSkillUsed && alive.has(target) && Number.isFinite(targetDistance) && targetDistance <= 5) {
      const currentRank = [...alive].map((id) => {
        const p = physics.getMarblePosition(id);
        return { id, d: progress.distanceAt(p.x, p.y) };
      }).sort((a, b) => a.d - b.d).findIndex((entry) => entry.id === target);
      if (currentRank >= 2) {
        physics.impact(target);
        lastChanceSkillUsed = true;
      }
    }

    if (alive.has(target) && elapsed - lastAssist >= 0.25) {
      if (Number.isFinite(targetDistance) && Number.isFinite(leaderDistance) &&
          targetDistance > leaderDistance + 0.25 && assists < 32) {
        physics.adjustMarbleSpeed(target, 1.25);
        assists++;
        lastAssist = elapsed;
      }

      for (const id of alive) {
        if (id === target) continue;
        const count = slowdownCounts.get(id) ?? 0;
        if (count >= 8) continue;
        physics.adjustMarbleSpeed(id, 0.95);
        slowdownCounts.set(id, count + 1);
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

  return {
    right: xAtCrossing !== null && xAtCrossing > OBSTACLE_MID_X,
    xAtCrossing: xAtCrossing ?? Number.NaN,
    first: finishOrder[0] === target,
    impulseApplied,
  };
}

async function main() {
  const trials = Math.max(1, Number(process.argv[2] ?? 500));
  const n = Math.max(2, Number(process.argv[3] ?? 5));
  const conditions: Condition[] = [
    { label: '무보정 기준', impulse: 0 },
    { label: '오른쪽 약한 보정 (+0.75)', impulse: 0.75 },
    { label: '오른쪽 강한 보정 (+1.5)', impulse: 1.5 },
    { label: '왼쪽 약한 보정 (-0.75)', impulse: -0.75 },
    { label: '왼쪽 강한 보정 (-1.5)', impulse: -1.5 },
  ];

  console.log(`맵: ${stageTitle()} / 참가: ${n} / 조건별 반복: ${trials}`);
  console.log('| 조건 | 오른쪽 통과 | 평균 교차 X | 1등 | 충격량 적용 |');
  console.log('|---|---:|---:|---:|---:|');

  for (const condition of conditions) {
    let rightCount = 0;
    let firstCount = 0;
    let impulseCount = 0;
    let xTotal = 0;
    let crossed = 0;
    for (let i = 0; i < trials; i++) {
      const result = await race(20261106 + i, n, condition);
      if (result.right) rightCount++;
      if (Number.isFinite(result.xAtCrossing)) {
        xTotal += result.xAtCrossing;
        crossed++;
      }
      if (result.first) firstCount++;
      if (result.impulseApplied) impulseCount++;
    }
    console.log(`| ${condition.label} | ${rightCount}/${crossed} (${(rightCount / Math.max(1, crossed) * 100).toFixed(1)}%) | ${(xTotal / Math.max(1, crossed)).toFixed(3)} | ${firstCount}/${trials} (${(firstCount / trials * 100).toFixed(1)}%) | ${impulseCount}/${trials} |`);
  }
}

function stageTitle() {
  return stages[0].title;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
