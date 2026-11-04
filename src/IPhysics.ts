import type { StageDef } from './data/maps';
import type { MapEntityState } from './types/MapEntity.type';

export interface IPhysics {
  init(): Promise<void>;

  clear(): void;

  clearMarbles(): void;

  createStage(stage: StageDef): void;

  createMarble(id: number, x: number, y: number): void;

  shakeMarble(id: number): void;

  removeMarble(id: number): void;

  /** 테스트 모드에서 지정 구슬에 출발 순간 작은 전진 충격량을 준다. */
  boostMarble(id: number, impulse: number): void;

  /** 테스트 모드에서 진행 방향을 유지한 채 현재 속도를 조정한다. */
  adjustMarbleSpeed(id: number, factor: number): void;

  getMarblePosition(id: number): { x: number; y: number; angle: number };

  getEntities(): MapEntityState[];

  impact(id: number): void;

  start(): void;

  step(deltaSeconds: number): void;
}
