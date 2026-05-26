import { geoCentroid, geoMercator, geoPath } from 'd3-geo';
import chinaGeo from 'china-map-geojson/lib/china';
import provinceData from 'china-map-geojson/lib/province';
import { regions } from './data';
import type { FactionState, FrontlineBattle, RegionConfig, SimulationState } from './types';

type SimpleGeometry = {
  type: string;
  coordinates: unknown;
};

type GeoFeature = {
  properties: {
    name: string;
    cp?: [number, number];
  };
  geometry: SimpleGeometry;
};

type ProvinceLibrary = Record<string, { features: GeoFeature[] }>;
type RegionSubFeature = GeoFeature & { __regionId: string; __regionName: string; __provinceName: string };

type CaptureAnimation = {
  battle: FrontlineBattle;
  progress: number;
  durationTicks: number;
  sourceCenter: [number, number];
  targetCenter: [number, number];
  /** 地图小块索引 → 变色阈值，progress 逐块推进，形成蚕食效果 */
  featureThresholds: Map<number, number>;
};

const provinceLibrary = provinceData as ProvinceLibrary;
const chinaFeatures = (chinaGeo as { features: GeoFeature[] }).features.filter((feature) => {
  return feature.properties.name !== '南海诸岛';
});

const provinceKeyMap: Record<string, string> = {
  安徽: 'Anhui',
  澳门: 'Aomen',
  北京: 'Beijing',
  重庆: 'Chongqing',
  福建: 'Fujian',
  甘肃: 'Gansu',
  广东: 'Guangdong',
  广西: 'Guangxi',
  贵州: 'Guizhou',
  海南: 'Hainan',
  河北: 'Hebei',
  河南: 'Henan',
  黑龙江: 'Heilongjiang',
  湖北: 'Hubei',
  湖南: 'Hunan',
  江苏: 'Jiangsu',
  江西: 'Jiangxi',
  吉林: 'Jilin',
  辽宁: 'Liaoning',
  内蒙古: 'Neimenggu',
  宁夏: 'Ningxia',
  青海: 'Qinghai',
  山东: 'Shandong',
  山西: 'Shanxi_1',
  陕西: 'Shanxi_3',
  上海: 'Shanghai',
  四川: 'Sichuan',
  台湾: 'Taiwan',
  天津: 'Tianjin',
  香港: 'Xianggang',
  新疆: 'Xinjiang',
  西藏: 'Xizang',
  云南: 'Yunnan',
  浙江: 'Zhejiang',
};

const regionSubFeatures: RegionSubFeature[] = regions.flatMap((region) => {
  return (region.provinceNames ?? []).flatMap((provinceName) => {
    const provinceKey = provinceKeyMap[provinceName];
    const province = provinceKey ? provinceLibrary[provinceKey] : null;
    if (!province) return [];

    return province.features.map((feature) => ({
      ...feature,
      __regionId: region.id,
      __regionName: region.name,
      __provinceName: provinceName,
    }));
  });
});

const CAPTURE_TICKS_PER_FEATURE = 0.42;
const CAPTURE_MIN_TICKS = 10;
const CAPTURE_MAX_TICKS = 36;
const DEFENDER_FLASH_TICKS = 18;
const NEUTRAL_COLOR = '#efe5d4';

const regionFeatureCounts = regionSubFeatures.reduce((counts, feature) => {
  counts.set(feature.__regionId, (counts.get(feature.__regionId) ?? 0) + 1);
  return counts;
}, new Map<string, number>());

function getCaptureDurationTicks(regionId: string, intensity: number) {
  const featureCount = regionFeatureCounts.get(regionId) ?? 16;
  const areaScaled = featureCount * CAPTURE_TICKS_PER_FEATURE;
  const intensityFactor = 1 - clamp((intensity - 8) * 0.01, 0, 0.15);
  return Math.round(clamp(areaScaled * intensityFactor, CAPTURE_MIN_TICKS, CAPTURE_MAX_TICKS));
}

export interface MapViewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function createDefaultViewport(): MapViewport {
  return { scale: 1, offsetX: 0, offsetY: 0 };
}

function hash01(seed: number) {
  const value = Math.sin(seed * 127.1 + 19.7) * 43758.5453;
  return value - Math.floor(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getFactionById(factions: FactionState[], id: string | null) {
  if (!id) return null;
  return factions.find((item) => item.id === id) ?? null;
}

function projectRegionPoints(
  region: RegionConfig,
  projection: (coords: [number, number]) => [number, number] | null,
) {
  const points: [number, number][] = [];

  (region.provinceNames ?? []).forEach((provinceName) => {
    const chinaFeature = chinaFeatures.find((feature) => feature.properties.name === provinceName);
    if (chinaFeature?.properties.cp) {
      const projected = projection(chinaFeature.properties.cp);
      if (projected) points.push(projected);
    }

    const provinceKey = provinceKeyMap[provinceName];
    const province = provinceKey ? provinceLibrary[provinceKey] : null;
    if (!province) return;

    province.features.forEach((feature) => {
      const centroid = projection(geoCentroid(feature as never));
      if (centroid) points.push(centroid);
    });
  });

  return points;
}

function getRegionCenter(
  region: RegionConfig,
  projection: (coords: [number, number]) => [number, number] | null,
  canvasWidth: number,
  canvasHeight: number,
) {
  const points = projectRegionPoints(region, projection);
  if (points.length > 0) {
    return [
      points.reduce((sum, point) => sum + point[0], 0) / points.length,
      points.reduce((sum, point) => sum + point[1], 0) / points.length,
    ] as [number, number];
  }

  const scaleX = canvasWidth / 900;
  const scaleY = canvasHeight / 780;
  return [region.center.x * scaleX, region.center.y * scaleY] as [number, number];
}

function projectT(point: [number, number], from: [number, number], to: [number, number]) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1) return 0.5;
  return clamp(((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSq, 0, 1);
}

function buildFeatureCaptureThresholds(
  regionId: string,
  sourceCenter: [number, number],
  targetCenter: [number, number],
  projection: (coords: [number, number]) => [number, number] | null,
) {
  const ranked: Array<{ featureIndex: number; score: number }> = [];

  regionSubFeatures.forEach((feature, featureIndex) => {
    if (feature.__regionId !== regionId) return;
    const center = projection(geoCentroid(feature as never));
    if (!center) return;
    ranked.push({
      featureIndex,
      score: projectT(center, sourceCenter, targetCenter),
    });
  });

  ranked.sort((left, right) => left.score - right.score || left.featureIndex - right.featureIndex);

  const thresholds = new Map<number, number>();
  const count = ranked.length;
  ranked.forEach(({ featureIndex }, rank) => {
    thresholds.set(featureIndex, (rank + 1) / count);
  });
  return thresholds;
}

function buildCaptureAnimations(
  state: SimulationState,
  regionCenters: Map<string, [number, number]>,
  projection: (coords: [number, number]) => [number, number] | null,
  tick: number,
): Map<string, CaptureAnimation> {
  const captures = new Map<string, CaptureAnimation>();
  const seenTargets = new Set<string>();

  for (const battle of state.recentBattles) {
    if (battle.outcome !== 'attacker_win') continue;
    const age = tick - battle.tick;
    const durationTicks = getCaptureDurationTicks(battle.targetRegionId, battle.intensity ?? 10);
    if (age > durationTicks) continue;
    if (seenTargets.has(battle.targetRegionId)) continue;

    const sourceCenter = regionCenters.get(battle.sourceRegionId);
    const targetCenter = regionCenters.get(battle.targetRegionId);
    if (!sourceCenter || !targetCenter) continue;

    seenTargets.add(battle.targetRegionId);
    const progress = clamp(age / durationTicks, 0, 1);

    captures.set(battle.targetRegionId, {
      battle,
      progress,
      durationTicks,
      sourceCenter,
      targetCenter,
      featureThresholds: buildFeatureCaptureThresholds(
        battle.targetRegionId,
        sourceCenter,
        targetCenter,
        projection,
      ),
    });
  }

  return captures;
}

function getStableOwner(regionId: string, state: SimulationState) {
  return state.regionOwners[regionId] ?? null;
}

function getVisualOwner(
  featureIndex: number,
  feature: RegionSubFeature,
  state: SimulationState,
  capture: CaptureAnimation | null,
): string | null {
  const stableOwner = getStableOwner(feature.__regionId, state);

  if (!capture || capture.battle.targetRegionId !== feature.__regionId) {
    return stableOwner;
  }

  const threshold = capture.featureThresholds.get(featureIndex) ?? 1;
  if (capture.progress >= threshold) {
    return capture.battle.attackerId;
  }

  return capture.battle.defenderId ?? null;
}

function isBorderRegion(state: SimulationState, regionId: string) {
  const owner = getStableOwner(regionId, state);
  if (!owner) return false;
  const region = regions.find((item) => item.id === regionId);
  if (!region) return false;

  return region.neighbors.some((neighborId) => {
    const neighborOwner = getStableOwner(neighborId, state);
    return neighborOwner !== null && neighborOwner !== owner;
  });
}

function isRegionUnderAttack(state: SimulationState, regionId: string, tick: number) {
  return state.recentBattles.some(
    (battle) =>
      battle.outcome === 'defender_hold' &&
      battle.targetRegionId === regionId &&
      tick - battle.tick <= DEFENDER_FLASH_TICKS,
  );
}

function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fillColor: string,
  font: string,
  outlineColor = 'rgba(255, 252, 244, 0.92)',
  outlineWidth = 3,
) {
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = outlineWidth;
  ctx.strokeStyle = outlineColor;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fillColor;
  ctx.fillText(text, x, y);
}

function drawSoldierMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  size: number,
  alpha = 1,
  facingAngle = 0,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(facingAngle);

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255, 252, 244, 0.92)';
  ctx.beginPath();
  ctx.moveTo(size * 0.2, 0);
  ctx.lineTo(-size * 0.55, size * 0.42);
  ctx.lineTo(-size * 0.35, 0);
  ctx.lineTo(-size * 0.55, -size * 0.42);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(31, 23, 16, 0.28)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  ctx.restore();
}

function getFeatureSoldierSlots(featureIndex: number, count: number, spread: number) {
  const slots: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    const angle = hash01(featureIndex * 17 + index * 3.7) * Math.PI * 2;
    const radius = spread * (0.35 + hash01(featureIndex + index * 11) * 0.65);
    slots.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return slots;
}

function getOwnerColor(ownerId: string | null, factions: FactionState[]) {
  if (!ownerId) return NEUTRAL_COLOR;
  const faction = getFactionById(factions, ownerId);
  return faction ? `${faction.color}d6` : NEUTRAL_COLOR;
}

function computeLabelCenters(
  state: SimulationState,
  projection: (coords: [number, number]) => [number, number] | null,
  canvasWidth: number,
  canvasHeight: number,
) {
  const buckets = new Map<string, { x: number; y: number; count: number }>();

  regions.forEach((region) => {
    const ownerId = getStableOwner(region.id, state);
    if (!ownerId) return;
    const center = getRegionCenter(region, projection, canvasWidth, canvasHeight);
    const bucket = buckets.get(ownerId) ?? { x: 0, y: 0, count: 0 };
    bucket.x += center[0];
    bucket.y += center[1];
    bucket.count += 1;
    buckets.set(ownerId, bucket);
  });

  const result = new Map<string, [number, number]>();
  buckets.forEach((bucket, ownerId) => {
    if (bucket.count === 0) return;
    result.set(ownerId, [bucket.x / bucket.count, bucket.y / bucket.count]);
  });
  return result;
}

export function renderMap(
  canvas: HTMLCanvasElement,
  state: SimulationState,
  focusedFactionId: string | null,
  viewport: MapViewport = createDefaultViewport(),
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f3e7d3';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(viewport.offsetX, viewport.offsetY);
  ctx.scale(viewport.scale, viewport.scale);

  const projection = geoMercator().fitExtent(
    [
      [88, 52],
      [canvas.width - 72, canvas.height - 96],
    ],
    chinaGeo as never,
  );
  const path = geoPath(projection, ctx);

  const regionCenters = new Map<string, [number, number]>();
  regions.forEach((region) => {
    regionCenters.set(region.id, getRegionCenter(region, projection, canvas.width, canvas.height));
  });

  const captureAnimations = buildCaptureAnimations(state, regionCenters, projection, state.tick);

  ctx.beginPath();
  path(chinaGeo as never);
  ctx.fillStyle = '#e4d1b6';
  ctx.fill();

  regionSubFeatures.forEach((feature, featureIndex) => {
    const center = projection(geoCentroid(feature as never));
    if (!center) return;

    const capture = captureAnimations.get(feature.__regionId) ?? null;
    const ownerId = getVisualOwner(featureIndex, feature, state, capture);
    const fillColor = getOwnerColor(ownerId, state.factions);

    ctx.beginPath();
    path(feature as never);
    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.strokeStyle = focusedFactionId === ownerId ? '#1f1710' : 'rgba(255, 250, 240, 0.92)';
    ctx.lineWidth = focusedFactionId === ownerId ? 1.4 : 0.8;
    ctx.stroke();
  });

  chinaFeatures.forEach((feature) => {
    ctx.beginPath();
    path(feature as never);
    ctx.strokeStyle = 'rgba(66, 43, 28, 0.18)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  });

  regionSubFeatures.forEach((feature, featureIndex) => {
    const center = projection(geoCentroid(feature as never));
    if (!center) return;

    const capture = captureAnimations.get(feature.__regionId) ?? null;
    const ownerId = getVisualOwner(featureIndex, feature, state, capture);
    const faction = getFactionById(state.factions, ownerId ?? null);
    if (!faction) return;

    const onBorder = isBorderRegion(state, feature.__regionId);
    const underAttack = isRegionUnderAttack(state, feature.__regionId, state.tick);
    const unitCount = Math.min(12, Math.floor(3 + faction.force / 13 + (onBorder || underAttack ? 2 : 0)));
    const spread = onBorder || underAttack ? 10 : 11;
    const slots = getFeatureSoldierSlots(featureIndex, unitCount, spread);

    let facing = hash01(featureIndex) * Math.PI * 2;
    if (capture) {
      const dx = capture.targetCenter[0] - capture.sourceCenter[0];
      const dy = capture.targetCenter[1] - capture.sourceCenter[1];
      const isAttackerSide = ownerId === capture.battle.attackerId;
      facing = Math.atan2(dy, dx) + (isAttackerSide ? 0 : Math.PI);
    }

    slots.forEach(([offsetX, offsetY], slotIndex) => {
      const wobbleX = Math.sin(state.tick * 0.07 + slotIndex + featureIndex) * 0.6;
      const wobbleY = Math.cos(state.tick * 0.06 + slotIndex * 1.2) * 0.6;
      const soldierX = center[0] + offsetX + wobbleX;
      const soldierY = center[1] + offsetY + wobbleY;

      if (ownerId !== faction.id) return;

      drawSoldierMarker(ctx, soldierX, soldierY, faction.color, onBorder || underAttack ? 2.5 : 2.1, 0.84, facing);
    });
  });

  const labelCenters = computeLabelCenters(state, projection, canvas.width, canvas.height);
  state.factions.forEach((faction) => {
    if (!faction.alive || faction.controlledRegions.size === 0) return;
    const center = labelCenters.get(faction.id);
    if (!center) return;
    const fontSize = Math.max(14, Math.min(22, 16 * viewport.scale));
    drawOutlinedText(
      ctx,
      faction.name,
      center[0],
      center[1],
      faction.color,
      `bold ${fontSize}px "Microsoft YaHei", sans-serif`,
      focusedFactionId === faction.id ? 'rgba(255, 252, 244, 0.98)' : 'rgba(255, 252, 244, 0.9)',
      focusedFactionId === faction.id ? 4 : 3,
    );
  });

  ctx.restore();
}
