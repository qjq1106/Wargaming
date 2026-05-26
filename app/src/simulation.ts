import { characters, factionTemplates, regions } from './data';
import type {
  BattleLogEntry,
  BattleOutcome,
  CharacterConfig,
  FactionState,
  FactionTemplate,
  FrontlineBattle,
  SimulationOptions,
  SimulationState,
} from './types';

const speedMultiplierMap = {
  slow: 0.65,
  normal: 1,
  fast: 1.45,
} as const;

const randomScaleMap = {
  low: 0.05,
  medium: 0.1,
  high: 0.16,
} as const;

function createSeededRandom(seed: number) {
  let value = seed % 2147483647;
  if (value <= 0) value += 2147483646;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getCharacter(id: string): CharacterConfig {
  const character = characters.find((item) => item.id === id);
  if (!character) {
    throw new Error(`未找到角色：${id}`);
  }
  return character;
}

function sumStats(members: CharacterConfig[]) {
  const sizeFactor = 1 + (members.length - 1) * 0.08;
  const total = members.reduce(
    (acc, member) => {
      acc.leadership += member.leadership;
      acc.offense += member.offense;
      acc.defense += member.defense;
      acc.mobility += member.mobility;
      acc.resilience += member.resilience;
      acc.strategy += member.strategy;
      return acc;
    },
    { leadership: 0, offense: 0, defense: 0, mobility: 0, resilience: 0, strategy: 0 },
  );

  return {
    attackBias: (total.offense + total.strategy * 0.35) / members.length / 100 * sizeFactor,
    defenseBias: (total.defense + total.leadership * 0.25) / members.length / 100 * sizeFactor,
    mobilityBias: (total.mobility + total.strategy * 0.18) / members.length / 100 * sizeFactor,
    resilienceBias: (total.resilience + total.leadership * 0.18) / members.length / 100 * sizeFactor,
  };
}

function createFactionState(template: FactionTemplate): FactionState {
  const members = template.characterIds.map(getCharacter);
  const statPack = sumStats(members);

  return {
    id: template.id,
    name: template.name,
    dynasty: template.dynasty,
    color: template.color,
    members,
    controlledRegions: new Set<string>([template.startRegionId]),
    alive: true,
    force: 88,
    morale: 86,
    pressure: 10,
    ...statPack,
  };
}

function makeLog(state: SimulationState, message: string) {
  const entry: BattleLogEntry = {
    id: `${state.tick}-${state.logs.length}`,
    tick: state.tick,
    message,
  };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 20);
}

function recordFrontlineBattle(
  state: SimulationState,
  sourceRegionId: string,
  targetRegionId: string,
  attackerId: string,
  defenderId: string | null,
  outcome: BattleOutcome,
  intensity: number,
) {
  const entry: FrontlineBattle = {
    sourceRegionId,
    targetRegionId,
    attackerId,
    defenderId,
    outcome,
    tick: state.tick,
    intensity,
  };
  state.recentBattles.unshift(entry);
  state.recentBattles = state.recentBattles.slice(0, 16);
}

function pickRandomRegions(seedRandom: () => number, count: number) {
  const pool = [...regions];
  const picks: string[] = [];
  while (pool.length > 0 && picks.length < count) {
    const index = Math.floor(seedRandom() * pool.length);
    picks.push(pool.splice(index, 1)[0].id);
  }
  return picks;
}

function createHistoricalAssignments(factionIds: string[]) {
  const orderedRegionIds = [
    'liaodong',
    'mobei',
    'xiliang',
    'hebei',
    'guanzhong',
    'shandong',
    'zhongyuan',
    'bashu',
    'jingchu',
    'jiangdong',
    'lingnan',
  ];

  return factionIds.map((_, index) => orderedRegionIds[index % orderedRegionIds.length]);
}

function pickOne<T>(items: T[], seedRandom: () => number) {
  if (items.length === 0) return null;
  return items[Math.floor(seedRandom() * items.length)];
}

export function createSimulation(templateIds: string[], options: SimulationOptions): SimulationState {
  const selectedTemplates = factionTemplates.filter((item) => templateIds.includes(item.id));
  const factions = selectedTemplates.map(createFactionState);
  const regionOwners = Object.fromEntries(regions.map((region) => [region.id, null as string | null]));
  const seedRandom = createSeededRandom(options.seed);

  const regionAssignments =
    options.mapMode === 'random'
      ? pickRandomRegions(seedRandom, factions.length)
      : createHistoricalAssignments(factions.map((item) => item.id));

  factions.forEach((faction, index) => {
    faction.controlledRegions = new Set([regionAssignments[index]]);
  });

  factions.forEach((faction) => {
    const [regionId] = [...faction.controlledRegions];
    regionOwners[regionId] = faction.id;
  });

  return {
    tick: 0,
    running: false,
    winnerId: null,
    speedMultiplier: speedMultiplierMap[options.speedName],
    factions,
    regionOwners,
    logs: [],
    eliminatedOrder: [],
    recentBattles: [],
  };
}

function getCombatTuning(state: SimulationState) {
  const aliveCount = state.factions.filter((item) => item.alive && item.controlledRegions.size > 0).length;
  let attackChance = 0.62;
  let winMargin = 7;

  if (state.tick > 45) {
    attackChance += 0.1;
    winMargin = 5;
  }
  if (state.tick > 95) {
    attackChance += 0.12;
    winMargin = 3;
  }
  if (aliveCount <= 3) {
    attackChance += 0.14;
    winMargin = 2;
  }

  return { attackChance, winMargin };
}

export function updateSimulation(state: SimulationState, options: SimulationOptions) {
  if (state.winnerId) return state;

  const seedRandom = createSeededRandom(options.seed + state.tick * 131 + state.logs.length * 19);
  const randomScale = randomScaleMap[options.randomLevel];
  state.tick += 1;

  // 中文注释：先更新各势力整体状态，让版图越大的一方逐渐承担更高补给与守边压力。
  state.factions.forEach((faction) => {
    const territoryCount = faction.controlledRegions.size;
    if (territoryCount === 0) {
      if (faction.alive) {
        faction.alive = false;
        state.eliminatedOrder.push(faction.id);
        makeLog(state, `${faction.name} 退出战局。`);
      }
      return;
    }

    faction.pressure = clamp(territoryCount * 8 + Math.max(0, territoryCount - 2) * 4, 8, 78);
    faction.morale = clamp(
      faction.morale + faction.resilienceBias * 0.8 - faction.pressure * 0.02 + (seedRandom() - 0.5) * 1.4,
      46,
      120,
    );
    faction.force = clamp(
      faction.force + faction.defenseBias * 0.55 - faction.pressure * 0.015 + (seedRandom() - 0.5) * 1.6,
      30,
      120,
    );
  });

  state.factions
    .filter((item) => item.alive && item.controlledRegions.size > 0)
    .forEach((attacker) => {
      const { attackChance, winMargin } = getCombatTuning(state);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const ownedRegionIds = [...attacker.controlledRegions];
        const sourceRegionId = pickOne(ownedRegionIds, seedRandom);
        if (!sourceRegionId) continue;

        const region = regions.find((item) => item.id === sourceRegionId);
        if (!region) continue;

      const enemyNeighborIds = region.neighbors.filter((neighborId) => {
        const ownerId = state.regionOwners[neighborId];
        return ownerId !== null && ownerId !== attacker.id;
      });
      const neutralNeighborIds = region.neighbors.filter((neighborId) => state.regionOwners[neighborId] === null);

      const canExpandNeutral =
        neutralNeighborIds.length > 0 &&
        attacker.controlledRegions.size < 4 &&
        seedRandom() < 0.22 + attacker.mobilityBias * 0.08;

      if (canExpandNeutral) {
        const targetId = pickOne(neutralNeighborIds, seedRandom);
        if (targetId) {
          state.regionOwners[targetId] = attacker.id;
          attacker.controlledRegions.add(targetId);
          attacker.force = clamp(attacker.force - 1.8, 24, 120);
          makeLog(state, `${attacker.name} 向 ${regions.find((item) => item.id === targetId)?.name} 扩张。`);
          recordFrontlineBattle(state, sourceRegionId, targetId, attacker.id, null, 'attacker_win', 14);
        }
        continue;
      }

      if (enemyNeighborIds.length === 0) continue;
      if (seedRandom() > attackChance + attacker.attackBias * 0.14) continue;

      const targetId = pickOne(enemyNeighborIds, seedRandom);
      if (!targetId) continue;

      const defenderId = state.regionOwners[targetId];
      const defender = state.factions.find((item) => item.id === defenderId && item.alive);
      if (!defender) continue;

      const attackerRoll =
        attacker.force * 0.26 +
        attacker.morale * 0.18 +
        attacker.attackBias * 26 +
        attacker.mobilityBias * 9 -
        attacker.pressure * 0.22 +
        (seedRandom() - 0.5) * 40 * randomScale;

      const defenderRoll =
        defender.force * 0.29 +
        defender.morale * 0.18 +
        defender.defenseBias * 28 +
        defender.resilienceBias * 11 -
        defender.pressure * 0.12 +
        (seedRandom() - 0.5) * 40 * randomScale;

      if (attackerRoll > defenderRoll + winMargin) {
        state.regionOwners[targetId] = attacker.id;
        attacker.controlledRegions.add(targetId);
        defender.controlledRegions.delete(targetId);
        attacker.force = clamp(attacker.force - 3, 24, 120);
        attacker.morale = clamp(attacker.morale + 2.2, 30, 120);
        defender.force = clamp(defender.force - 5.4, 18, 120);
        defender.morale = clamp(defender.morale - 4.5, 20, 120);
        makeLog(state, `${attacker.name} 击破 ${defender.name}，夺下 ${regions.find((item) => item.id === targetId)?.name}。`);
        recordFrontlineBattle(
          state,
          sourceRegionId,
          targetId,
          attacker.id,
          defender.id,
          'attacker_win',
          Math.max(8, attackerRoll - defenderRoll),
        );
      } else {
        attacker.force = clamp(attacker.force - 2.2, 18, 120);
        attacker.morale = clamp(attacker.morale - 1.5, 20, 120);
        defender.force = clamp(defender.force - 0.8, 18, 120);
        defender.morale = clamp(defender.morale + 0.6, 20, 120);
        recordFrontlineBattle(
          state,
          sourceRegionId,
          targetId,
          attacker.id,
          defender.id,
          'defender_hold',
          Math.max(6, defenderRoll - attackerRoll + winMargin),
        );
        if (seedRandom() < 0.22) {
          makeLog(state, `${defender.name} 在 ${regions.find((item) => item.id === targetId)?.name} 守住战线。`);
        }
      }
      }
    });

  state.factions.forEach((faction) => {
    if (faction.alive && faction.controlledRegions.size === 0) {
      faction.alive = false;
      state.eliminatedOrder.push(faction.id);
      makeLog(state, `${faction.name} 已被完全吞并。`);
    }
  });

  const aliveFactions = state.factions.filter((item) => item.alive && item.controlledRegions.size > 0);
  if (aliveFactions.length === 1) {
    state.winnerId = aliveFactions[0].id;
    state.running = false;
    makeLog(state, `${aliveFactions[0].name} 完成统一，成为本局胜者。`);
  }

  return state;
}

export function getWinner(state: SimulationState) {
  return state.factions.find((item) => item.id === state.winnerId) ?? null;
}
