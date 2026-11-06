/**
 * Wheel of fortune: 마지막 반시계 회전 막대와 실제 접촉한 쪽(왼쪽/오른쪽) 측정.
 * Read-only baseline: 구슬에 충격량/가속/감속/스킬을 적용하지 않는다.
 * npm run sidebias -- [trials=500] [marbles=5]
 */
import * as fs from 'node:fs';
import Box2DFactory from 'box2d-wasm';
import { stages } from '../src/data/maps';
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

type Side = 'left' | 'right' | 'center' | 'no-contact';
type MarbleResult = { side: Side; first: boolean; contactX: number | null };

async function race(seed: number, n: number): Promise<MarbleResult[]> {
  seedRandom(seed);
  const stage = stages[0];
  const obstacleIndex = stage.entities!.findIndex((e) =>
    e.type === 'kinematic' && Math.abs(e.position.x - 14) < 0.001 &&
    Math.abs(e.position.y - 106.75) < 0.001 && e.props.angularVelocity < 0
  );
  if (obstacleIndex < 0) throw new Error('마지막 반시계 회전 장애물을 찾지 못했습니다.');
  const obstacleX = stage.entities![obstacleIndex].position.x;

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
  const sides: (Side | null)[] = Array(n).fill(null);
  const contactXs: (number | null)[] = Array(n).fill(null);
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
      if (sides[id] !== null) continue;
      const body = internal.marbleMap[id];
      if (!body) continue;
      let hit = false;
      for (let edge = body.GetContactList(); getPointer(edge) !== 0; edge = edge.next) {
        if (!edge.contact.IsTouching()) continue;
        const a = edge.contact.GetFixtureA().GetBody();
        const b = edge.contact.GetFixtureB().GetBody();
        if (getPointer(a) === getPointer(obstacleBody) || getPointer(b) === getPointer(obstacleBody)) {
          hit = true;
          break;
        }
      }
      if (hit) {
        const p = physics.getMarblePosition(id);
        contactXs[id] = p.x;
        sides[id] = p.x < obstacleX - 0.05 ? 'left' : p.x > obstacleX + 0.05 ? 'right' : 'center';
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

  return Array.from({ length: n }, (_, id) => ({
    side: sides[id] ?? 'no-contact',
    first: finishOrder[0] === id,
    contactX: contactXs[id],
  }));
}

async function main() {
  const trials = Math.max(1, Number(process.argv[2] ?? 500));
  const n = Math.max(2, Number(process.argv[3] ?? 5));
  const totals: Record<Side, { marbles: number; wins: number }> = {
    left: { marbles: 0, wins: 0 },
    right: { marbles: 0, wins: 0 },
    center: { marbles: 0, wins: 0 },
    'no-contact': { marbles: 0, wins: 0 },
  };
  let completed = 0;
  for (let i = 0; i < trials; i++) {
    const results = await race(20261106 + i, n);
    if (results.some(r => r.first)) completed++;
    for (const r of results) {
      totals[r.side].marbles++;
      if (r.first) totals[r.side].wins++;
    }
  }

  console.log(`맵: ${stages[0].title} / 참가: ${n} / 반복: ${trials} / 완주 레이스: ${completed}`);
  console.log('분류 기준: 마지막 반시계 막대(중심 x=14)와 처음 실제 접촉했을 때 구슬 중심이 막대 중심의 어느 쪽인지');
  console.log('| 접촉 경로 | 구슬 수 | 1등 | 해당 경로의 1등 비율 |');
  console.log('|---|---:|---:|---:|');
  for (const side of ['left', 'right', 'center', 'no-contact'] as Side[]) {
    const v = totals[side];
    console.log(`| ${side} | ${v.marbles} | ${v.wins} | ${v.marbles ? (v.wins / v.marbles * 100).toFixed(2) : '0.00'}% |`);
  }
  console.log('주의: 이 수치는 마지막 막대와 실제 접촉한 쪽의 상관관계이며, 어느 쪽이 승리를 유발한다고 단정하지 않습니다.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
