export type CharacterRole = 'emperor' | 'general' | 'strategist' | 'royal' | 'partner';

export interface CharacterConfig {
  id: string;
  name: string;
  dynasty: string;
  role: CharacterRole;
  leadership: number;
  offense: number;
  defense: number;
  mobility: number;
  resilience: number;
  strategy: number;
  tags: string[];
}

export interface RegionConfig {
  id: string;
  name: string;
  neighbors: string[];
  center: { x: number; y: number };
  polygon: Array<{ x: number; y: number }>;
  provinceNames?: string[];
}

export interface FactionTemplate {
  id: string;
  name: string;
  dynasty: string;
  color: string;
  characterIds: string[];
  startRegionId: string;
}

export interface FactionState {
  id: string;
  name: string;
  dynasty: string;
  color: string;
  members: CharacterConfig[];
  controlledRegions: Set<string>;
  alive: boolean;
  force: number;
  morale: number;
  pressure: number;
  attackBias: number;
  defenseBias: number;
  mobilityBias: number;
  resilienceBias: number;
}

export interface BattleLogEntry {
  id: string;
  tick: number;
  message: string;
}

export type BattleOutcome = 'attacker_win' | 'defender_hold';

export interface FrontlineBattle {
  sourceRegionId: string;
  targetRegionId: string;
  attackerId: string;
  defenderId: string | null;
  outcome: BattleOutcome;
  tick: number;
  intensity: number;
}

export interface SimulationOptions {
  randomLevel: 'low' | 'medium' | 'high';
  mapMode: 'historical' | 'random';
  speedName: 'slow' | 'normal' | 'fast';
  seed: number;
}

export interface SimulationState {
  tick: number;
  running: boolean;
  winnerId: string | null;
  speedMultiplier: number;
  factions: FactionState[];
  regionOwners: Record<string, string | null>;
  logs: BattleLogEntry[];
  eliminatedOrder: string[];
  recentBattles: FrontlineBattle[];
}
