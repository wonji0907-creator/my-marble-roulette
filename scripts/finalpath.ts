/**
 * Wheel of fortune: 마지막 장애물 직전 접근 상태와 접촉/완주 순서를 비교.
 * Read-only diagnostic: 게임 물리/스킬/구슬 속도에 어떠한 개입도 하지 않는다.
 * npx tsx scripts/finalpath.ts [trials=500] [marbles=5]
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { stages } from '../src/data/maps';
import { Box2dPhysics } from '../src/physics-box2d';

const STEP = 0.01;
const MAX_SECONDS = 240;
const ENTRY_Y = 104.5;

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

type Approach = { x: number; speed: number; vy: number; time: number };
type MarbleResult = {
  id: number;
  contact: boolean;
  first: boolean;
  rank: number | null;
  entry: Approach | null;
  contactTime: number | null;
  finishTime: number | null;
};

async function race(seed: number, n: number): Promise<MarbleResult[]> {
  seedRandom(seed);
  const stage = stages[0];
  const obstacleIndex = stage.entities!.findIndex((e) =>
    e.type === 'kinematic' && Math.abs(e.position.x - 14) < 0.001 &&
    Math.abs(e.position.y - 106.75) < 0.001 && e.props.angularVelocity < 0
  );
  if (obstacleIndex < 0) throw new Error('마지막 반시계 회전 장애물을 찾지 못했습니다.');

  const physics = new NodePhysics();
  await physics.init();
  physics.createStage(stage);
  const rows = Math.ceil(n / 10);
  const lineDelta = -Math.max(0, Math.ceil(rows - 5));
  for (let id = 0; id < n; id++) {
    const line = Math.floor(id / 10);
    physics.createMarble(id, 10.25 + (id % 10) * 0.6, rows - line + lineDelta);
  }
  physics.start();

  const internal = physics as any;
  const obstacleBody = internal.entities[obstacleIndex].body;
  const getPointer = internal.Box2D.getPointer;
  const data: MarbleResult[] = Array.from({ length: n }, (_, id) => ({
    id, contact: false, first: false, rank: null, entry: null, contactTime: null, finishTime: null,
  }));
  const alive = new Set(Array.from({ length: n }, (_, i) => i));
  const finishOrder: number[] = [];
  const removals: { id: number; time: number }[] = [];
  let elapsed = 0;

  while (alive.size && elapsed < MAX_SECONDS) {
    physics.step(STEP);
    elapsed += STEP;

    while (removals.length && removals[0].time <= elapsed) {
      physics.removeMarble(removals.shift()!.id);
    }

    for (const id of alive) {
      const row = data[id];
      const body = internal.marbleMap[id];
      if (!body) continue;

      const telemetry = physics.getMarbleTelemetry(id);
      if (!telemetry) continue;
      if (!row.entry && telemetry.y >= ENTRY_Y) {
        row.entry = { x: telemetry.x, speed: telemetry.speed, vy: telemetry.vy, time: elapsed };
      }

      if (!row.contact) {
        for (let edge = body.GetContactList(); getPointer(edge) !== 0; edge = edge.next) {
          if (!edge.contact.IsTouching()) continue;
          const a = edge.contact.GetFixtureA().GetBody();
          const b = edge.contact.GetFixtureB().GetBody();
          if (getPointer(a) === getPointer(obstacleBody) || getPointer(b) === getPointer(obstacleBody)) {
            row.contact = true;
            row.contactTime = elapsed;
            break;
          }
        }
      }
    }

    for (const id of [...alive]) {
      const p = physics.getMarblePosition(id);
      if (p.y > stage.goalY) {
        finishOrder.push(id);
        const row = data[id];
        row.finishTime = elapsed;
        row.rank = finishOrder.length;
        row.first = finishOrder.length === 1;
        alive.delete(id);
        removals.push({ id, time: elapsed + 0.5 });
      }
    }
    removals.sort((a, b) => a.time - b.time);
  }

  return data;
}

function summarize(rows: MarbleResult[]) {
  const finished = rows.filter(r => r.rank !== null);
  const wins = rows.filter(r => r.first).length;
  const withEntry = rows.filter(r => r.entry);
  const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {
    count: rows.length,
    finished: finished.length,
    wins,
    winRate: rows.length ? wins / rows.length * 100 : 0,
    firsts: rows.filter(r => r.rank === 1).length,
    seconds: rows.filter(r => r.rank === 2).length,
    avgEntryX: avg(withEntry.map(r => r.entry!.x)),
    avgEntrySpeed: avg(withEntry.map(r => r.entry!.speed)),
    avgEntryVy: avg(withEntry.map(r => r.entry!.vy)),
    avgEntryTime: avg(withEntry.map(r => r.entry!.time)),
    avgContactTime: avg(rows.filter(r => r.contactTime !== null).map(r => r.contactTime!)),
    avgFinishTime: avg(finished.map(r => r.finishTime!)),
  };
}

async function main() {
  const trials = Math.max(1, Number(process.argv[2] ?? 500));
  const n = Math.max(2, Number(process.argv[3] ?? 5));
  const all: MarbleResult[] = [];
  let completedRaces = 0;

  for (let i = 0; i < trials; i++) {
    const rows = await race(20261106 + i, n);
    if (rows.some(r => r.first)) completedRaces++;
    all.push(...rows);
  }

  console.log(`맵: ${stages[0].title} / 참가: ${n} / 반복: ${trials} / 완주 레이스: ${completedRaces}`);
  console.log(`접근 측정 기준: 마지막 장애물 직전 y >= ${ENTRY_Y}`);
  console.log('| 그룹 | 구슬 | 완주 | 1등 | 1등 비율 | 평균 접근 x | 평균 접근 속력 | 평균 접근 시간 | 평균 접촉 시간 | 평균 완주 시간 |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');

  for (const [label, rows] of [
    ['bar-contact', all.filter(r => r.contact)],
    ['no-contact', all.filter(r => !r.contact)],
    ['all', all],
  ] as [string, MarbleResult[]][]) {
    const s = summarize(rows);
    console.log(`| ${label} | ${s.count} | ${s.finished} | ${s.wins} | ${s.winRate.toFixed(2)}% | ${s.avgEntryX.toFixed(3)} | ${s.avgEntrySpeed.toFixed(3)} | ${s.avgEntryTime.toFixed(3)}s | ${s.avgContactTime.toFixed(3)}s | ${s.avgFinishTime.toFixed(3)}s |`);
  }

  console.log('');
  console.log('| 시작 슬롯(id) | 구슬 | 막대 접촉 | 미접촉 | 1등 | 1등 비율 | 미접촉 중 1등 |');
  console.log('|---:|---:|---:|---:|---:|---:|---:|');
  for (let id = 0; id < n; id++) {
    const rows = all.filter(r => r.id === id);
    const noContact = rows.filter(r => !r.contact);
    const wins = rows.filter(r => r.first).length;
    const noContactWins = noContact.filter(r => r.first).length;
    console.log(`| ${id} | ${rows.length} | ${rows.filter(r => r.contact).length} | ${noContact.length} | ${wins} | ${(wins / rows.length * 100).toFixed(2)}% | ${noContactWins} |`);
  }

  console.log('');
  console.log('| 미접촉 구슬 완주 순위 | 구슬 수 |');
  console.log('|---:|---:|');
  for (let rank = 1; rank <= n; rank++) {
    console.log(`| ${rank}위 | ${all.filter(r => !r.contact && r.rank === rank).length} |`);
  }
  console.log(`| 미완주 | ${all.filter(r => r.rank === null).length} |`);
  console.log('주의: 접근 속력/위치와 접촉 여부는 관찰값이며, 원인과 결과를 단정하지 않습니다.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
