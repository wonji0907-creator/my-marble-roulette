/**
 * Wheel of fortune: 게임의 현재 추격 보정과 하단 도달 스킬 조건을 그대로 재현하는 실험기.
 * npm run winrate -- [trials=500] [marbles=5]
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { stages } from '../src/data/maps';
import { ProgressMap } from '../src/progressMap';
import { Box2dPhysics } from '../src/physics-box2d';
import { STUCK_DELAY, zoomThreshold } from '../src/data/constants';
import { zoomZoneIntensity } from '../src/zoomZone';

const STEP = 0.01;
const MAX_SECONDS = 240;
const RANK_EMA_SEC = 0.4;
const RANK_MARGIN = 0.25;

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

async function race(seed: number, n: number, skillEnabled: boolean): Promise<Outcome> {
  seedRandom(seed);
  const stage = stages[0];
  const progress = ProgressMap.for(stage);
  const physics = new NodePhysics();
  await physics.init();
  physics.createStage(stage);

  // setMarbles()와 같은 Fisher–Yates 섞기. 첫 입력 참가자의 구슬 ID도 실제처럼 무작위로 정한다.
  const orders = Array.from({ length: n }, (_, i) => i);
  for (let i = orders.length; i > 0; i--) {
    const j = Math.floor(Math.random() * i);
    [orders[i - 1], orders[j]] = [orders[j], orders[i - 1]];
  }
  const target = orders[orders.length - 1] || 0;
  const rows = Math.ceil(n / 10);
  const lineDelta = -Math.max(0, Math.ceil(rows - 5));
  const cooldowns = new Map<number, number>();
  const lastPositions = new Map<number, { x: number; y: number }>();
  const stuckTimes = new Map<number, number>();
  const maxCooldown = 4600; // setMarbles()가 기본 참가자 weight를 0.1로 정규화
  const participantIds: number[] = [];
  for (let participant = 0; participant < n; participant++) {
    const id = orders.pop() ?? 0;
    participantIds.push(id);
    cooldowns.set(id, maxCooldown * Math.random()); // Marble 생성자의 초기 쿨타임 난수
    lastPositions.set(id, { x: 0, y: 0 }); // Marble.lastPosition 초기값
    stuckTimes.set(id, 0);
    const line = Math.floor(id / 10);
    // createMarble 내부의 질량 난수까지 실제 생성 순서대로 소비한다.
    physics.createMarble(id, 10.25 + (id % 10) * 0.6, rows - line + lineDelta);
  }

  const activeOrder = participantIds.slice();
  // activeOrder는 화면의 _marbles 배열처럼 결승선을 통과한 구슬을 즉시 제외한다.
  const removals: { id: number; time: number }[] = [];
  const finishOrder: number[] = [];
  const slowdownCounts = new Map<number, number>();
  const rankKeys = new Map<number, number>();
  let elapsed = 0;
  let chaseElapsed = 0;
  let lastAssist = -Infinity;
  let assists = 0;
  let slowdowns = 0;
  let skillTriggered = false;

  physics.start();
  while (activeOrder.length && elapsed < MAX_SECONDS) {
    // _calcTimeScale()과 같은 결승 연출 슬로모션. 현재 정렬 순서의 커트라인 두 구슬을 사용한다.
    let timeScale = 1;
    if (finishOrder.length === 0 && activeOrder.length > 1) {
      const leader = physics.getMarblePosition(activeOrder[0]);
      const rival = physics.getMarblePosition(activeOrder[1]);
      if (stage.zoomZones?.length) {
        const a = zoomZoneIntensity(stage.zoomZones, leader.x, leader.y);
        const b = zoomZoneIntensity(stage.zoomZones, rival.x, rival.y);
        const intensity = Math.max(a, b);
        if (intensity > 0) timeScale = Math.max(0.2, 1 - intensity);
      } else {
        const a = Math.max(0, 1 - Math.abs(stage.zoomY - leader.y) / zoomThreshold);
        const b = Math.max(0, 1 - Math.abs(stage.zoomY - rival.y) / zoomThreshold);
        const focus = b > a ? rival : leader;
        const goalDist = Math.abs(stage.zoomY - focus.y);
        if (goalDist < zoomThreshold && focus.y > stage.zoomY - zoomThreshold * 1.2) {
          timeScale = Math.max(0.2, goalDist / zoomThreshold);
        }
      }
    }

    physics.step(STEP * timeScale);
    elapsed += STEP;
    chaseElapsed += STEP * timeScale;

    while (removals.length && removals[0].time <= elapsed) {
      physics.removeMarble(removals.shift()!.id);
    }

    // 일반 스킬(useSkills=true)도 OFF/ON 양쪽에서 동일하게 유지한다.
    // Marble.update()와 같은 벽시계 기준 쿨타임 및 발동 확률(weight 0.1 → 2%).
    for (const id of activeOrder) {
      // Marble.update()의 정지 워치독: 초기 lastPosition=(0,0), 벽시계 누적 10ms.
      const position = physics.getMarblePosition(id);
      const previous = lastPositions.get(id) ?? { x: 0, y: 0 };
      const movedSq = (position.x - previous.x) ** 2 + (position.y - previous.y) ** 2;
      if (movedSq < 0.00001 * timeScale * timeScale) {
        const stuck = (stuckTimes.get(id) ?? 0) + 10;
        if (stuck > STUCK_DELAY) {
          physics.shakeMarble(id);
          stuckTimes.set(id, 0);
        } else {
          stuckTimes.set(id, stuck);
        }
      } else {
        stuckTimes.set(id, 0);
      }
      lastPositions.set(id, { x: position.x, y: position.y });

      const next = (cooldowns.get(id) ?? 0) - STEP * 1000;
      if (next <= 0) {
        if (Math.random() < 0.02) physics.impact(id);
        cooldowns.set(id, maxCooldown);
      } else {
        cooldowns.set(id, next);
      }
    }

    // 게임처럼 현재 _marbles 배열 순서대로 이번 틱의 결승 통과자를 기록한다.
    const crossed: number[] = [];
    for (const id of activeOrder) {
      if (physics.getMarblePosition(id).y > stage.goalY) {
        crossed.push(id);
        if (!finishOrder.includes(id)) finishOrder.push(id);
      }
    }

    // 하단 도달 스킬은 일반 스킬 처리 후, 결승 통과자를 _marbles에서 제외하기 전에 검사한다.
    if (skillEnabled && !skillTriggered && activeOrder.includes(target)) {
      const bottomReached = activeOrder.some((id) =>
        physics.getMarblePosition(id).y >= stage.goalY - 5
      );
      const designatedIsFirst = finishOrder.length > 0
        ? finishOrder[0] === target
        : activeOrder[0] === target;
      if (bottomReached && !designatedIsFirst) {
        physics.impact(target);
        skillTriggered = true;
      }
    }

    // Wheel of fortune 추격 가속/상대 감속의 주기와 횟수 제한을 유지한다.
    const intervalReady = chaseElapsed - lastAssist >= 0.25;
    if (activeOrder.includes(target) && intervalReady) {
      const current = activeOrder.map((id) => {
        const p = physics.getMarblePosition(id);
        return { id, d: progress.distanceAt(p.x, p.y) };
      });
      const targetDistance = current.find((m) => m.id === target)?.d ?? Infinity;
      const leaderDistance = Math.min(...current.filter((m) => m.id !== target).map((m) => m.d));

      if (Number.isFinite(targetDistance) && Number.isFinite(leaderDistance) &&
          targetDistance > leaderDistance + RANK_MARGIN && assists < 32) {
        physics.adjustMarbleSpeed(target, 1.2);
        assists++;
        lastAssist = chaseElapsed;
      }
      for (const id of activeOrder) {
        if (id === target) continue;
        const count = slowdownCounts.get(id) ?? 0;
        if (count >= 8) continue;
        physics.adjustMarbleSpeed(id, 0.95);
        slowdownCounts.set(id, count + 1);
        slowdowns++;
        lastAssist = chaseElapsed;
      }
    }

    for (const id of crossed) {
      const index = activeOrder.indexOf(id);
      if (index >= 0) activeOrder.splice(index, 1);
      removals.push({ id, time: elapsed + 0.5 });
    }
    removals.sort((a, b) => a.time - b.time);

    // Roulette._sortMarbles(): 0.4초 EMA + 0.25 거리 여유를 반영한 순위 갱신.
    const dt = STEP * timeScale;
    const alpha = 1 - Math.exp(-dt / RANK_EMA_SEC);
    const keys = new Map<number, number>();
    let known = 0;
    for (const id of activeOrder) {
      const p = physics.getMarblePosition(id);
      const raw = progress.distanceAt(p.x, p.y);
      const prev = rankKeys.get(id);
      if (prev !== undefined) known++;
      keys.set(id, prev !== undefined ? prev + (raw - prev) * alpha : raw);
    }
    rankKeys.clear();
    for (const [id, key] of keys) rankKeys.set(id, key);
    if (known < activeOrder.length / 2) {
      activeOrder.sort((a, b) =>
        keys.get(a)! - keys.get(b)! ||
        physics.getMarblePosition(b).y - physics.getMarblePosition(a).y
      );
    } else {
      for (let i = 1; i < activeOrder.length; i++) {
        const id = activeOrder[i];
        const key = keys.get(id)! + RANK_MARGIN;
        let j = i;
        while (j > 0 && key < keys.get(activeOrder[j - 1])!) {
          activeOrder[j] = activeOrder[j - 1];
          j--;
        }
        activeOrder[j] = id;
      }
    }
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
  const variants = [
    { label: 'A 스킬 OFF', skillEnabled: false },
    { label: 'B 스킬 ON', skillEnabled: true },
  ];
  const totals = variants.map(() => ({
    first: 0, second: 0, topTwo: 0, skill: 0,
    assists: 0, slowdowns: 0, seconds: 0,
  }));
  let pairedFirstWins = 0;
  let pairedSecondWins = 0;
  let pairedTopTwoWins = 0;

  for (let i = 0; i < trials; i++) {
    const seed = 20261606 + i;
    const a = await race(seed, n, variants[0].skillEnabled);
    const b = await race(seed, n, variants[1].skillEnabled);
    const results = [a, b];

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const total = totals[j];
      if (result.first) total.first++;
      if (result.second) total.second++;
      if (result.first || result.second) total.topTwo++;
      if (result.skillTriggered) total.skill++;
      total.assists += result.assists;
      total.slowdowns += result.slowdowns;
      total.seconds += result.seconds;
    }

    if (!a.first && b.first) pairedFirstWins++;
    if (!a.second && b.second) pairedSecondWins++;
    if (!(a.first || a.second) && (b.first || b.second)) pairedTopTwoWins++;
  }

  console.log(`맵: ${stages[0].title} / 참가: ${n} / 동일 시드: ${trials}개 (A/B 각 ${trials}회)`);
  console.log('| 항목 | A 스킬 OFF | B 스킬 ON | 차이(B-A) |');
  console.log('|---|---:|---:|---:|');
  const pct = (v: number) => (v / trials * 100).toFixed(1) + '%';
  const diffPct = (a: number, b: number) => ((b - a) / trials * 100).toFixed(1) + '%p';
  console.log(`| 지정 구슬 1등 | ${totals[0].first} (${pct(totals[0].first)}) | ${totals[1].first} (${pct(totals[1].first)}) | ${diffPct(totals[0].first, totals[1].first)} |`);
  console.log(`| 지정 구슬 2등 | ${totals[0].second} (${pct(totals[0].second)}) | ${totals[1].second} (${pct(totals[1].second)}) | ${diffPct(totals[0].second, totals[1].second)} |`);
  console.log(`| 1·2등 합계 | ${totals[0].topTwo} (${pct(totals[0].topTwo)}) | ${totals[1].topTwo} (${pct(totals[1].topTwo)}) | ${diffPct(totals[0].topTwo, totals[1].topTwo)} |`);
  console.log(`| 스킬 발동 | ${totals[0].skill} (${pct(totals[0].skill)}) | ${totals[1].skill} (${pct(totals[1].skill)}) | - |`);
  console.log(`| 평균 추격 가속 | ${(totals[0].assists / trials).toFixed(1)} | ${(totals[1].assists / trials).toFixed(1)} | - |`);
  console.log(`| 평균 상대 감속 | ${(totals[0].slowdowns / trials).toFixed(1)} | ${(totals[1].slowdowns / trials).toFixed(1)} | - |`);
  console.log(`| 평균 레이스 시간 | ${(totals[0].seconds / trials).toFixed(1)}s | ${(totals[1].seconds / trials).toFixed(1)}s | - |`);
  console.log(`동일 시드에서 OFF 실패 → ON 성공: 1등 ${pairedFirstWins}회 / 2등 ${pairedSecondWins}회 / 1·2등 진입 ${pairedTopTwoWins}회`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
