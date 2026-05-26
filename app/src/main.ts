import './style.css';
import { factionTemplates } from './data';
import { createDefaultViewport, renderMap, type MapViewport } from './render';
import { createSimulation, getWinner, updateSimulation } from './simulation';
import type { SimulationOptions, SimulationState } from './types';

const appElement = document.querySelector<HTMLDivElement>('#app');

if (!appElement) {
  throw new Error('应用挂载节点不存在');
}

const app = appElement;
const initialSelectedFactionIds = factionTemplates.slice(0, 6).map((item) => item.id);
let selectedFactionIds = [...initialSelectedFactionIds];
let options: SimulationOptions = {
  randomLevel: 'medium',
  mapMode: 'historical',
  speedName: 'normal',
  seed: Date.now() % 1000000,
};
let simulationState: SimulationState | null = null;
let focusedFactionId: string | null = null;
let mapViewport: MapViewport = createDefaultViewport();
let isMapDragging = false;
let mapRenderScheduled = false;
let lastPanelRenderTime = 0;
const PANEL_RENDER_INTERVAL_MS = 320;
let animationFrameId = 0;
let lastFrameTime = 0;
let stepAccumulator = 0;
let leftPanelCollapsed = false;
let rightPanelCollapsed = false;

function getFactionLabel(factionId: string) {
  const faction = factionTemplates.find((item) => item.id === factionId);
  return faction ? `${faction.name} · ${faction.dynasty}` : factionId;
}

function getStepInterval() {
  const speedScale = simulationState?.speedMultiplier ?? 1;
  const base =
    options.speedName === 'slow' ? 300 : options.speedName === 'fast' ? 100 : 175;
  return base / speedScale;
}

function createLayout() {
  app.innerHTML = `
    <div class="shell" id="app-shell">
      <div class="sidebar-slot sidebar-slot-left" id="sidebar-slot-left">
        <button type="button" class="sidebar-toggle sidebar-toggle-left" id="toggle-left-panel" title="收起/展开配置面板" aria-label="收起或展开左侧配置面板">◀</button>
        <aside class="sidebar config-panel" id="config-panel">
          <div class="panel-header">
            <p class="eyebrow">开局配置</p>
            <h1>历史人物乱斗模拟</h1>
            <p class="summary">玩家只负责组局与观战，系统自动开战。</p>
          </div>
          <section class="panel-block">
            <h2>参战势力</h2>
            <div id="faction-list" class="faction-list"></div>
          </section>
          <section class="panel-block">
            <h2>局势参数</h2>
            <label class="field">
              <span>随机强度</span>
              <select id="random-level">
                <option value="low">低</option>
                <option value="medium" selected>中</option>
                <option value="high">高</option>
              </select>
            </label>
            <label class="field">
              <span>出生方式</span>
              <select id="map-mode">
                <option value="historical" selected>历史倾向</option>
                <option value="random">随机乱斗</option>
              </select>
            </label>
            <label class="field">
              <span>初始速度</span>
              <select id="speed-name">
                <option value="slow">慢</option>
                <option value="normal" selected>标准</option>
                <option value="fast">快</option>
              </select>
            </label>
          </section>
          <section class="panel-block action-block">
            <button id="start-button" class="primary-button">开始这一局</button>
            <button id="reset-config-button" class="ghost-button">恢复默认配置</button>
          </section>
        </aside>
      </div>

      <main class="main-stage">
        <section class="canvas-wrap">
          <canvas id="war-canvas" width="900" height="780"></canvas>
          <div class="toolbar">
            <button id="pause-button" class="toolbar-button">暂停</button>
            <button id="resume-button" class="toolbar-button">继续</button>
            <button id="speed-button" class="toolbar-button">切换速度</button>
            <button id="restart-button" class="toolbar-button">重开本局</button>
          </div>
        </section>
      </main>

      <div class="sidebar-slot sidebar-slot-right" id="sidebar-slot-right">
        <button type="button" class="sidebar-toggle sidebar-toggle-right" id="toggle-right-panel" title="收起/展开战局面板" aria-label="收起或展开右侧战局面板">▶</button>
        <aside class="sidebar status-panel" id="status-panel">
          <section class="panel-block">
            <div class="panel-title-row">
              <h2>战局信息</h2>
              <span id="tick-badge" class="badge">未开始</span>
            </div>
            <div id="winner-card" class="winner-card muted">尚未开战</div>
          </section>
          <section class="panel-block">
            <h2>势力排名</h2>
            <div id="ranking-list" class="ranking-list"></div>
          </section>
          <section class="panel-block">
            <h2>最近战报</h2>
            <div id="log-list" class="log-list"></div>
          </section>
          <section class="panel-block">
            <h2>结算信息</h2>
            <div id="result-list" class="result-list muted">战斗结束后会展示胜者和灭亡顺序。</div>
          </section>
        </aside>
      </div>
    </div>
  `;
}

function applySidebarLayout() {
  const shell = document.querySelector<HTMLDivElement>('#app-shell');
  const leftToggle = document.querySelector<HTMLButtonElement>('#toggle-left-panel');
  const rightToggle = document.querySelector<HTMLButtonElement>('#toggle-right-panel');
  if (!shell || !leftToggle || !rightToggle) return;

  shell.classList.toggle('left-collapsed', leftPanelCollapsed);
  shell.classList.toggle('right-collapsed', rightPanelCollapsed);
  leftToggle.textContent = leftPanelCollapsed ? '▶' : '◀';
  rightToggle.textContent = rightPanelCollapsed ? '◀' : '▶';
  leftToggle.title = leftPanelCollapsed ? '展开配置面板' : '收起配置面板';
  rightToggle.title = rightPanelCollapsed ? '展开战局面板' : '收起战局面板';
  window.requestAnimationFrame(() => resizeCanvas());
}

function bindSidebarToggles() {
  document.querySelector<HTMLButtonElement>('#toggle-left-panel')?.addEventListener('click', () => {
    leftPanelCollapsed = !leftPanelCollapsed;
    applySidebarLayout();
  });

  document.querySelector<HTMLButtonElement>('#toggle-right-panel')?.addEventListener('click', () => {
    rightPanelCollapsed = !rightPanelCollapsed;
    applySidebarLayout();
  });
}

function clampViewportScale(scale: number) {
  return Math.max(0.6, Math.min(4, scale));
}

const ZOOM_SENSITIVITY = 0.0016;

function scheduleMapRender() {
  if (mapRenderScheduled) return;
  mapRenderScheduled = true;
  window.requestAnimationFrame(() => {
    mapRenderScheduled = false;
    refreshCanvas();
  });
}

function refreshPanels(force = false) {
  const now = performance.now();
  if (!force && now - lastPanelRenderTime < PANEL_RENDER_INTERVAL_MS) {
    scheduleMapRender();
    return;
  }
  lastPanelRenderTime = now;
  renderRanking();
  renderLogs();
  renderResult();
  scheduleMapRender();
}

function resetMapViewport() {
  mapViewport = createDefaultViewport();
}

function bindMapInteractions() {
  const canvas = document.querySelector<HTMLCanvasElement>('#war-canvas');
  if (!canvas) return;

  canvas.onwheel = (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const pointerX = (event.clientX - rect.left) * scaleX;
    const pointerY = (event.clientY - rect.top) * scaleY;
    const zoomFactor = Math.exp(-event.deltaY * ZOOM_SENSITIVITY);
    const nextScale = clampViewportScale(mapViewport.scale * zoomFactor);
    const scaleRatio = nextScale / mapViewport.scale;

    mapViewport = {
      scale: nextScale,
      offsetX: pointerX - (pointerX - mapViewport.offsetX) * scaleRatio,
      offsetY: pointerY - (pointerY - mapViewport.offsetY) * scaleRatio,
    };
    scheduleMapRender();
  };

  canvas.onpointerdown = (event) => {
    if (event.button !== 0) return;
    isMapDragging = true;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
  };

  canvas.onpointermove = (event) => {
    if (!isMapDragging) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    mapViewport = {
      scale: mapViewport.scale,
      offsetX: mapViewport.offsetX + event.movementX * scaleX,
      offsetY: mapViewport.offsetY + event.movementY * scaleY,
    };
    scheduleMapRender();
  };

  const stopDragging = (event: PointerEvent) => {
    if (!isMapDragging) return;
    isMapDragging = false;
    canvas.classList.remove('is-dragging');
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  canvas.onpointerup = stopDragging;
  canvas.onpointercancel = stopDragging;
}

function resizeCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>('#war-canvas');
  const wrap = document.querySelector<HTMLElement>('.canvas-wrap');
  if (!canvas || !wrap) return;

  const width = Math.max(720, Math.floor(wrap.clientWidth - 24));
  const height = Math.max(620, Math.floor(wrap.clientHeight - 24));
  canvas.width = width;
  canvas.height = height;
  scheduleMapRender();
}

function renderFactionChecklist() {
  const factionList = document.querySelector<HTMLDivElement>('#faction-list');
  if (!factionList) return;

  factionList.innerHTML = factionTemplates
    .map(
      (faction) => `
        <label class="faction-item">
          <input type="checkbox" value="${faction.id}" ${selectedFactionIds.includes(faction.id) ? 'checked' : ''} />
          <span class="swatch" style="background:${faction.color}"></span>
          <span class="faction-copy">
            <strong>${faction.name}</strong>
            <small>${faction.characterIds.length} 人阵容 · ${faction.dynasty}</small>
          </span>
        </label>
      `,
    )
    .join('');

  factionList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      const nextSelected = new Set(selectedFactionIds);
      if (input.checked) {
        nextSelected.add(input.value);
      } else if (nextSelected.size > 2) {
        nextSelected.delete(input.value);
      } else {
        input.checked = true;
      }
      selectedFactionIds = factionTemplates.map((item) => item.id).filter((id) => nextSelected.has(id));
    });
  });
}

function renderRanking() {
  const rankingList = document.querySelector<HTMLDivElement>('#ranking-list');
  if (!rankingList) return;

  if (!simulationState) {
    rankingList.innerHTML = '<p class="muted">开始后会显示势力排名和领土变化。</p>';
    return;
  }

  const ranking = [...simulationState.factions].sort(
    (left, right) => right.controlledRegions.size - left.controlledRegions.size || right.force - left.force,
  );

  rankingList.innerHTML = ranking
    .map((faction, index) => {
      const focused = focusedFactionId === faction.id ? ' ranking-item-active' : '';
      return `
        <button class="ranking-item${focused}" data-faction-id="${faction.id}">
          <div class="ranking-head">
            <span class="ranking-index">#${index + 1}</span>
            <span class="swatch" style="background:${faction.color}"></span>
            <strong>${faction.name}</strong>
          </div>
          <div class="ranking-meta">
            <span>领土 ${faction.controlledRegions.size}</span>
            <span>兵势 ${faction.force.toFixed(0)}</span>
            <span>${faction.alive ? '存活' : '出局'}</span>
          </div>
        </button>
      `;
    })
    .join('');

  rankingList.querySelectorAll<HTMLButtonElement>('.ranking-item').forEach((button) => {
    button.addEventListener('click', () => {
      focusedFactionId = button.dataset.factionId ?? null;
      refreshPanels(true);
    });
  });
}

function renderLogs() {
  const logList = document.querySelector<HTMLDivElement>('#log-list');
  if (!logList) return;

  if (!simulationState || simulationState.logs.length === 0) {
    logList.innerHTML = '<p class="muted">战局开始后会不断滚动战报。</p>';
    return;
  }

  logList.innerHTML = simulationState.logs
    .map((log) => `<div class="log-item"><span>第 ${log.tick} 轮</span><p>${log.message}</p></div>`)
    .join('');
}

function renderResult() {
  const resultList = document.querySelector<HTMLDivElement>('#result-list');
  const winnerCard = document.querySelector<HTMLDivElement>('#winner-card');
  const tickBadge = document.querySelector<HTMLSpanElement>('#tick-badge');
  if (!resultList || !winnerCard || !tickBadge) return;

  if (!simulationState) {
    winnerCard.className = 'winner-card muted';
    winnerCard.textContent = '尚未开战';
    tickBadge.textContent = '未开始';
    resultList.className = 'result-list muted';
    resultList.textContent = '战斗结束后会展示胜者和灭亡顺序。';
    return;
  }

  tickBadge.textContent = `第 ${simulationState.tick} 轮`;
  const winner = getWinner(simulationState);
  if (!winner) {
    winnerCard.className = 'winner-card';
    winnerCard.innerHTML = `<strong>战斗进行中</strong><span>当前存活 ${simulationState.factions.filter((item) => item.alive).length} 个势力</span>`;
  } else {
    winnerCard.className = 'winner-card winner';
    winnerCard.innerHTML = `<strong>${winner.name}</strong><span>完成统一，共占领 ${winner.controlledRegions.size} 个区域</span>`;
  }

  const eliminatedCopy = simulationState.eliminatedOrder.map((id, index) => `<li>${index + 1}. ${getFactionLabel(id)}</li>`);
  resultList.className = 'result-list';
  resultList.innerHTML = `
    <div class="result-section">
      <p>${winner ? `本局胜者：${winner.name}` : '胜者尚未产生'}</p>
    </div>
    <div class="result-section">
      <h3>灭亡顺序</h3>
      <ol>${eliminatedCopy.join('') || '<li>暂无</li>'}</ol>
    </div>
  `;
}

function refreshCanvas() {
  const canvas = document.querySelector<HTMLCanvasElement>('#war-canvas');
  if (!canvas || !simulationState) return;
  renderMap(canvas, simulationState, focusedFactionId, mapViewport);
}

function startSimulation(resetSeed = false) {
  if (selectedFactionIds.length < 2) return;

  if (resetSeed) {
    options.seed = Date.now() % 1000000;
  }
  options = {
    ...options,
    randomLevel: (document.querySelector<HTMLSelectElement>('#random-level')?.value ?? 'medium') as SimulationOptions['randomLevel'],
    mapMode: (document.querySelector<HTMLSelectElement>('#map-mode')?.value ?? 'historical') as SimulationOptions['mapMode'],
    speedName: (document.querySelector<HTMLSelectElement>('#speed-name')?.value ?? 'normal') as SimulationOptions['speedName'],
  };

  simulationState = createSimulation(selectedFactionIds, options);
  simulationState.running = true;
  focusedFactionId = selectedFactionIds[0] ?? null;
  stepAccumulator = 0;
  resetMapViewport();
  resizeCanvas();
  refreshPanels(true);
}

function bindActions() {
  document.querySelector<HTMLButtonElement>('#start-button')?.addEventListener('click', () => {
    startSimulation(true);
  });

  document.querySelector<HTMLButtonElement>('#reset-config-button')?.addEventListener('click', () => {
    selectedFactionIds = [...initialSelectedFactionIds];
    options = { ...options, randomLevel: 'medium', mapMode: 'historical', speedName: 'normal' };
    createLayout();
    setup();
  });

  document.querySelector<HTMLButtonElement>('#pause-button')?.addEventListener('click', () => {
    if (simulationState) simulationState.running = false;
  });

  document.querySelector<HTMLButtonElement>('#resume-button')?.addEventListener('click', () => {
    if (simulationState && !simulationState.winnerId) simulationState.running = true;
  });

  document.querySelector<HTMLButtonElement>('#restart-button')?.addEventListener('click', () => {
    startSimulation(false);
  });

  document.querySelector<HTMLButtonElement>('#speed-button')?.addEventListener('click', () => {
    const order: SimulationOptions['speedName'][] = ['slow', 'normal', 'fast'];
    const currentIndex = order.indexOf(options.speedName);
    const next = order[(currentIndex + 1) % order.length];
    options = { ...options, speedName: next };
    const speedSelect = document.querySelector<HTMLSelectElement>('#speed-name');
    if (speedSelect) speedSelect.value = next;
    if (simulationState) {
      simulationState.speedMultiplier = next === 'slow' ? 0.65 : next === 'normal' ? 1 : 1.45;
    }
  });
}

function tick(timestamp: number) {
  if (!lastFrameTime) {
    lastFrameTime = timestamp;
  }
  const delta = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  if (simulationState?.running) {
    stepAccumulator += delta;
    const stepInterval = getStepInterval();

    while (stepAccumulator >= stepInterval) {
      updateSimulation(simulationState, options);
      stepAccumulator -= stepInterval;
      if (simulationState.winnerId) {
        break;
      }
    }
    refreshPanels(simulationState.winnerId !== null);
    scheduleMapRender();
  } else if (simulationState) {
    scheduleMapRender();
  }

  animationFrameId = window.requestAnimationFrame(tick);
}

function setup() {
  renderFactionChecklist();
  bindActions();
  bindMapInteractions();
  bindSidebarToggles();
  applySidebarLayout();
  renderRanking();
  renderLogs();
  renderResult();
}

createLayout();
setup();
animationFrameId = window.requestAnimationFrame(tick);

window.addEventListener('resize', resizeCanvas);
window.addEventListener('beforeunload', () => {
  window.cancelAnimationFrame(animationFrameId);
});
