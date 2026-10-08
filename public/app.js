// Renders the weekly plan (public/data/plan.json) and overlays live status from GitHub (/api/state).

const STATUS_LABEL = { done: 'Done', pr: 'PR open', ready: 'Ready', waiting: 'Waiting', unknown: 'Unknown' };
const STATUS_ORDER = ['done', 'pr', 'ready', 'waiting'];
const LEGEND_LABEL = { done: 'done', pr: 'with a PR open', ready: 'ready to start', waiting: 'waiting' };
const LETTERS = 'ABCDEFGHIJ';
const STEP_LABELS = ['First', 'Then', 'After that', 'Finally'];
const GITHUB_MARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const NODE_W = 176;
const NODE_H = 54;
const COL_GAP = 64;
const ROW_GAP = 14;
const LANE_TOP = 30;

const ui = {
  plan: null,
  live: null, // Map of issue number -> live issue, or null when GitHub is not reachable
  signedIn: false,
  viewer: null,
  fetchedAt: null,
  notice: '',
  focused: null,
  errors: {},
  inFlight: new Set(), // bundle ids with a GitHub request running
  optimistic: {}, // bundle id -> { kind: 'claim' | 'release', until } shown before GitHub confirms
  view: 'auto', // 'auto' shows only your bundle once you have one; 'all' shows every bundle
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

init();

async function init() {
  ui.plan = await fetch('/data/plan.json', { cache: 'no-cache' }).then((r) => r.json());
  ui.view = loadView();
  document.title = `${ui.plan.teamName} This Week`;
  document.getElementById('team-name').textContent = ui.plan.teamName;
  const params = new URLSearchParams(location.search);
  if (params.get('signin') === 'denied') {
    ui.notice = `Only members of team ${ui.plan.teamName} can sign in. You can still read the plan.`;
    history.replaceState(null, '', location.pathname);
  } else if (params.get('signin') === 'failed') {
    const reason = params.get('reason');
    ui.notice = `GitHub sign-in did not finish${reason ? `: ${reason}` : ''}. Try again.`;
    history.replaceState(null, '', location.pathname);
  }
  render();
  await refresh();

  setInterval(() => document.visibilityState === 'visible' && refresh(), 60_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
  document.addEventListener('click', onClick);
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderMap, 120);
  });
}

async function refresh() {
  try {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `status ${res.status}`);
    }
    ui.signedIn = data.signedIn;
    ui.viewer = data.viewer;
    ui.fetchedAt = data.fetchedAt || null;
    ui.live = data.issues ? new Map(data.issues.map((i) => [i.number, i])) : null;
    if (!ui.live) {
      ui.notice = 'Sign in with GitHub to see live progress and pick a bundle.';
    } else if (ui.notice.startsWith('Sign in') || ui.notice.startsWith('Live status')) {
      ui.notice = '';
    }
  } catch (err) {
    ui.notice = `Live status is unavailable right now (${err.message}). Showing the plan only.`;
  }
  render();
}

//// Plan and live data

function allIssues() {
  return ui.plan.bundles.flatMap((b) => b.issues);
}

function inPlan(number) {
  return Object.hasOwn(ui.plan.issues, String(number));
}

function planIssue(number) {
  return ui.plan.issues[String(number)];
}

function shortName(number) {
  return planIssue(number)?.short || ui.live?.get(number)?.title || `#${number}`;
}

function blockersOf(number) {
  const live = ui.live?.get(number);
  const all = live ? live.blockedBy.map((b) => b.number) : planIssue(number).blockedBy;
  return all.filter(inPlan);
}

function openBlockersOf(number) {
  const live = ui.live?.get(number);
  if (!live) {
    return [];
  }
  return live.blockedBy.filter((b) => b.state === 'OPEN').map((b) => b.number);
}

function dependentsOf(number) {
  return allIssues().filter((n) => blockersOf(n).includes(number));
}

function laterDependents(number) {
  const live = ui.live?.get(number);
  return live ? live.blocking.filter((b) => !inPlan(b.number) && b.state === 'OPEN').length : 0;
}

function statusOf(number) {
  const live = ui.live?.get(number);
  if (!live) {
    return 'unknown';
  }
  if (live.state === 'CLOSED') {
    return 'done';
  }
  if (live.prs.some((pr) => pr.state === 'OPEN')) {
    return 'pr';
  }
  return openBlockersOf(number).length ? 'waiting' : 'ready';
}

function bundleOf(number) {
  return ui.plan.bundles.find((b) => b.issues.includes(number));
}

function letterOf(bundle) {
  return LETTERS[ui.plan.bundles.indexOf(bundle)];
}

function effortOf(number) {
  return planIssue(number).effort;
}

function ownersOf(bundle) {
  if (!ui.live) {
    return [];
  }
  const owners = new Map();
  for (const n of bundle.issues) {
    for (const a of ui.live.get(n)?.assignees ?? []) {
      owners.set(a.login, a);
    }
  }
  const guess = ui.optimistic[bundle.id];
  if (guess && guess.until > Date.now() && ui.viewer) {
    const login = ui.viewer.login;
    if (guess.kind === 'claim') {
      owners.set(login, owners.get(login) ?? { login, avatar: `https://github.com/${encodeURIComponent(login)}.png?size=64` });
    } else {
      owners.delete(login);
    }
  }
  return [...owners.values()];
}

function myBundles() {
  if (!ui.signedIn || !ui.viewer) {
    return [];
  }
  return ui.plan.bundles.filter((b) => ownersOf(b).some((o) => o.login === ui.viewer.login));
}

/** True when the page should focus on the viewer's own bundle. */
function isMineMode() {
  return ui.view !== 'all' && myBundles().length > 0;
}

function nameOf(login, fallback) {
  return ui.plan.team.find((m) => m.login === login)?.name || fallback || login;
}

function reachable(start, next) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    for (const n of next(stack.pop())) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

//// Rendering

function render() {
  document.body.classList.toggle('mine-mode', isMineMode());
  renderAccount();
  renderWeek();
  renderNotice();
  renderTeam();
  renderMap();
  renderBundles();
  renderFooter();
}

function renderAccount() {
  const el = document.getElementById('account');
  if (ui.signedIn && ui.viewer) {
    const login = ui.viewer.login;
    el.innerHTML = `
      <img src="https://github.com/${encodeURIComponent(login)}.png?size=64" alt="">
      <span>${esc(nameOf(login))}</span>
      <button class="linkish" data-action="signout">Sign out</button>`;
  } else {
    el.innerHTML = `<a class="button" href="/auth/login">${GITHUB_MARK}Sign in with GitHub</a>`;
  }
}

function renderWeek() {
  const { milestone, headline, checkpoints = [] } = ui.plan;
  const due = parseDate(milestone.due);
  const days = Math.round((due - startOfToday()) / 86_400_000);
  const left = days > 1 ? `${days} days left`
      : days === 1 ? '1 day left'
      : days === 0 ? 'due today'
      : `${-days} day${days === -1 ? '' : 's'} overdue`;

  const total = allIssues().reduce((sum, n) => sum + effortOf(n), 0) || 1;
  const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, { effort: 0, count: 0 }]));
  for (const n of allIssues()) {
    const s = statusOf(n);
    if (byStatus[s]) {
      byStatus[s].effort += effortOf(n);
      byStatus[s].count += 1;
    }
  }

  const bar = ui.live
      ? STATUS_ORDER.filter((s) => byStatus[s].effort > 0)
          .map((s) => `<span class="s-${s}" style="width:${(byStatus[s].effort / total) * 100}%;background:var(--c)"
              title="${STATUS_LABEL[s]}: ${byStatus[s].count} task${byStatus[s].count === 1 ? '' : 's'}"></span>`)
          .join('')
      : '';
  const doneShare = ui.live ? Math.round((byStatus.done.effort / total) * 100) : null;
  const legend = ui.live
      ? STATUS_ORDER.map((s) => `<span><span class="dot s-${s}"></span> <b>${byStatus[s].count}</b> ${LEGEND_LABEL[s]}</span>`).join('')
          + `<span>${doneShare}% of the week's work is done</span>`
      : '<span>Progress appears here once you sign in.</span>';

  const today = startOfToday();
  const checkpointItems = checkpoints.map((c) => {
    const date = parseDate(c.date);
    return `<li class="${date < today ? 'past' : ''}"><b>${esc(formatDate(date))}</b>${fmt(c.text)}</li>`;
  }).join('');

  document.getElementById('week').innerHTML = `
    <div class="week-title">
      <h1>${esc(milestone.title)}</h1>
      <div class="due">Due <strong>${esc(formatDate(due))}</strong> · ${left}</div>
    </div>
    <p class="week-headline">${fmt(headline)}</p>
    <div class="progress" role="img" aria-label="Progress by status">${bar}</div>
    <div class="legend">${legend}</div>
    ${checkpointItems ? `<ul class="checkpoints">${checkpointItems}</ul>` : ''}`;
}

function renderNotice() {
  const el = document.getElementById('notice');
  el.hidden = !ui.notice;
  el.textContent = ui.notice;
}

function renderTeam() {
  document.getElementById('team').innerHTML = ui.plan.team.map((member) => {
    const taken = ui.plan.bundles.filter((b) => ownersOf(b).some((o) => o.login === member.login));
    const what = !ui.live ? '—'
        : taken.length ? taken.map((b) => `${letterOf(b)} · ${b.name}`).join(', ')
        : 'Hasn\'t picked yet';
    return `
      <div class="member ${taken.length ? '' : 'free'}">
        <img src="https://github.com/${encodeURIComponent(member.login)}.png?size=80" alt="" loading="lazy"
            onerror="this.remove()">
        <div style="min-width:0">
          <div class="who">${esc(member.name)}</div>
          <div class="what" title="${esc(what)}">${esc(what)}</div>
        </div>
      </div>`;
  }).join('');
}

function mapLanes() {
  const issues = allIssues();
  const depth = new Map();
  const visit = (n, path) => {
    if (depth.has(n)) {
      return depth.get(n);
    }
    if (path.has(n)) {
      return 0; // a cycle in the data; draw it flat rather than loop forever
    }
    path.add(n);
    const blockers = blockersOf(n);
    const d = blockers.length ? 1 + Math.max(...blockers.map((b) => visit(b, path))) : 0;
    path.delete(n);
    depth.set(n, d);
    return d;
  };
  issues.forEach((n) => visit(n, new Set()));
  const lanes = [];
  issues.forEach((n) => (lanes[depth.get(n)] ||= []).push(n));
  return lanes;
}

/** Links to draw: a -> c is skipped when a already reaches c through another task. */
function directEdges() {
  const edges = [];
  for (const n of allIssues()) {
    const blockers = blockersOf(n);
    for (const b of blockers) {
      if (!blockers.some((other) => other !== b && reachable(other, blockersOf).has(b))) {
        edges.push([b, n]);
      }
    }
  }
  return edges;
}

/** Orders a lane so each task sits near the tasks it waits on. */
function sortLane(lane, pos, axis) {
  const issues = allIssues();
  const centre = (n) => {
    const values = blockersOf(n).map((b) => pos.get(b)[axis]);
    return values.reduce((a, b) => a + b, 0) / values.length;
  };
  lane.sort((a, b) => centre(a) - centre(b) || issues.indexOf(a) - issues.indexOf(b));
}

function layoutMap(available) {
  const lanes = mapLanes();
  const acrossWidth = lanes.length * NODE_W + (lanes.length - 1) * COL_GAP;
  return acrossWidth <= available ? layoutAcross(lanes, acrossWidth) : layoutDown(lanes, available);
}

/** Lanes as columns, read left to right. */
function layoutAcross(lanes, width) {
  const maxRows = Math.max(...lanes.map((lane) => lane.length));
  const height = LANE_TOP + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
  const pos = new Map();
  const labels = [];
  lanes.forEach((lane, c) => {
    if (c > 0) {
      sortLane(lane, pos, 'y');
    }
    const x = c * (NODE_W + COL_GAP);
    const laneHeight = lane.length * NODE_H + (lane.length - 1) * ROW_GAP;
    const top = LANE_TOP + (height - LANE_TOP - laneHeight) / 2;
    labels.push({ text: laneLabel(c, lanes.length), x, y: 12 });
    lane.forEach((n, r) => pos.set(n, { x, y: top + r * (NODE_H + ROW_GAP) }));
  });
  return { pos, labels, width, height, nodeW: NODE_W, vertical: false };
}

/** Lanes as rows, read top to bottom, for narrow screens. */
function layoutDown(lanes, available) {
  const gap = 12;
  const perRow = available >= 2 * 140 + gap ? 2 : 1;
  const nodeW = Math.floor((available - gap * (perRow - 1)) / perRow);
  const pos = new Map();
  const labels = [];
  let y = 0;
  lanes.forEach((lane, l) => {
    if (l > 0) {
      sortLane(lane, pos, 'x');
    }
    labels.push({ text: laneLabel(l, lanes.length), x: 0, y: y + 12 });
    y += LANE_TOP - 6;
    lane.forEach((n, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, lane.length - row * perRow);
      const offset = ((perRow - inRow) * (nodeW + gap)) / 2;
      pos.set(n, { x: offset + (i % perRow) * (nodeW + gap), y: y + row * (NODE_H + ROW_GAP) });
    });
    const rows = Math.ceil(lane.length / perRow);
    y += rows * NODE_H + (rows - 1) * ROW_GAP + 28;
  });
  return { pos, labels, width: available, height: y - 28, nodeW, vertical: true };
}

function laneLabel(index, count) {
  if (index === 0) {
    return 'Start now';
  }
  if (index === count - 1 && count > 2) {
    return 'Finally';
  }
  return ['Next', 'Then', 'After that', 'Later'][index - 1] || `Step ${index + 1}`;
}

function renderMap() {
  const map = document.getElementById('map');
  if (!allIssues().length) {
    map.innerHTML = '<p class="hint">The map appears once this week\'s plan is written.</p>';
    return;
  }
  const style = getComputedStyle(map);
  const available = map.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const { pos, labels, width, height, nodeW, vertical } = layoutMap(available);
  const lanes = labels.map((l) => `<text class="lane-label" x="${l.x}" y="${l.y}">${l.text}</text>`).join('');

  const paths = directEdges().map(([from, to]) => {
    const a = pos.get(from);
    const b = pos.get(to);
    const done = statusOf(from) === 'done' ? ' done' : '';
    let d;
    if (vertical) {
      const x1 = a.x + nodeW / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + nodeW / 2;
      const y2 = b.y;
      const bend = (y2 - y1) / 2;
      d = `M${x1} ${y1} C${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
    } else {
      const x1 = a.x + nodeW;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const bend = (x2 - x1) / 2;
      d = `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    }
    return `<path class="edge${done}" data-from="${from}" data-to="${to}" d="${d}"/>`;
  }).join('');

  const mine = new Set(isMineMode() ? myBundles().flatMap((b) => b.issues) : []);
  map.classList.toggle('mine-mode', mine.size > 0);
  const nodes = allIssues().map((n) => {
    const { x, y } = pos.get(n);
    const status = statusOf(n);
    const bundle = bundleOf(n);
    return `
      <g class="node s-${status}${mine.has(n) ? ' mine' : ''}" data-n="${n}" transform="translate(${x} ${y})" tabindex="0" role="button"
          aria-label="#${n} ${esc(shortName(n))}, ${STATUS_LABEL[status]}, bundle ${letterOf(bundle)}">
        <title>#${n} ${esc(ui.live?.get(n)?.title || planIssue(n).title)} (${STATUS_LABEL[status]})</title>
        <rect width="${nodeW}" height="${NODE_H}" rx="10"/>
        <circle cx="16" cy="18" r="4"/>
        <text class="num" x="27" y="22">#${n}</text>
        <text class="letter" x="${nodeW - 12}" y="22" text-anchor="end">${letterOf(bundle)}</text>
        <text class="name" x="14" y="41">${esc(shortName(n))}</text>
      </g>`;
  }).join('');

  map.innerHTML = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Task dependency map">
      ${lanes}${paths}${nodes}
    </svg>`;

  map.querySelectorAll('.node').forEach((node) => {
    const n = Number(node.dataset.n);
    node.addEventListener('mouseenter', () => focusIssue(n));
    node.addEventListener('mouseleave', () => focusIssue(null));
    node.addEventListener('focus', () => focusIssue(n));
    node.addEventListener('blur', () => focusIssue(null));
    node.addEventListener('click', () => goToTask(n));
    node.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && goToTask(n));
  });
  focusIssue(ui.focused);
}

function focusIssue(number) {
  ui.focused = number;
  const map = document.getElementById('map');
  map.classList.toggle('focus', number !== null);
  if (number === null) {
    return;
  }
  const up = reachable(number, blockersOf);
  const down = reachable(number, dependentsOf);
  const lit = new Set([number, ...up, ...down]);
  map.querySelectorAll('.node').forEach((node) => {
    const n = Number(node.dataset.n);
    node.classList.toggle('on', lit.has(n));
    node.classList.toggle('self', n === number);
  });
  map.querySelectorAll('.edge').forEach((edge) => {
    const from = Number(edge.dataset.from);
    const to = Number(edge.dataset.to);
    const upstream = (up.has(from) || from === number) && (up.has(to) || to === number);
    const downstream = (down.has(from) || from === number) && (down.has(to) || to === number);
    edge.classList.toggle('on', upstream || downstream);
  });
}

function renderBundles() {
  const total = allIssues().reduce((sum, n) => sum + effortOf(n), 0);
  const shares = new Map(ui.plan.bundles.map((b) => [b.id, b.issues.reduce((s, n) => s + effortOf(n), 0) / total]));
  const maxShare = Math.max(...shares.values());
  const mineMode = isMineMode();
  const mine = myBundles();
  const shown = mineMode ? mine : ui.plan.bundles;
  if (!shown.length) {
    document.getElementById('bundles').innerHTML =
        '<p class="hint">No bundles yet. Run the weekly-plan skill to write this week\'s plan.</p>';
    return;
  }

  document.getElementById('bundles-title').textContent = mineMode
      ? (mine.length > 1 ? 'Your bundles' : 'Your bundle') : 'Pick a bundle';
  document.getElementById('bundles-hint').innerHTML = mineMode
      ? `Your part of ${esc(ui.plan.milestone.title)}, in order. <button class="linkish" data-action="view-all">See all bundles</button>`
      : `Each bundle is about a fifth of the week. <em>Assign me</em> assigns every task in it to you on GitHub.${
        mine.length ? ' <button class="linkish" data-action="view-mine">Show only mine</button>' : ''}`;

  document.getElementById('bundles').innerHTML = shown.map((bundle) => `
    <article class="bundle${mineMode ? ' mine' : ''}" data-bundle="${esc(bundle.id)}"
        style="view-transition-name: bundle-${esc(bundle.id)}; view-transition-class: bundle">
      <div class="bundle-head">
        <h3 class="bundle-name"><span class="letter-badge">${letterOf(bundle)}</span>${esc(bundle.name)}</h3>
        <p class="bundle-tagline">${fmt(bundle.tagline)}</p>
        <div class="share">
          <div class="share-track"><span style="width:${(shares.get(bundle.id) / maxShare) * 100}%"></span></div>
          <span>about ${Math.round(shares.get(bundle.id) * 100)}% of the week</span>
        </div>
      </div>
      <div class="bundle-tasks">
        ${bundle.issues.map((n, step) => renderTask(n, step, bundle.issues.length)).join('')}
      </div>
      <div class="bundle-foot">${renderOwner(bundle)}</div>
    </article>`).join('');

  document.querySelectorAll('.task').forEach((task) => {
    const n = Number(task.dataset.n);
    task.addEventListener('mouseenter', () => focusIssue(n));
    task.addEventListener('mouseleave', () => focusIssue(null));
  });
}

function renderTask(number, step, steps) {
  const plan = planIssue(number);
  const live = ui.live?.get(number);
  const status = statusOf(number);
  const title = live?.title || plan.title;
  const url = live?.url || `https://github.com/${ui.plan.repo}/issues/${number}`;
  const stepLabel = steps > 1 ? (STEP_LABELS[step] || `Step ${step + 1}`) : '';

  const waitingOn = openBlockersOf(number);
  const unlocks = dependentsOf(number).filter((n) => statusOf(n) !== 'done');
  const later = laterDependents(number);
  const ripple = [];
  if (status !== 'done' && waitingOn.length) {
    ripple.push(`<div class="ripple"><span class="arrow">←</span> Waiting on ${waitingOn.map(chip).join('')}</div>`);
  }
  if (status !== 'done' && (unlocks.length || later)) {
    let text;
    if (!unlocks.length) {
      text = later === 1 ? '1 task in a later week builds on this' : `${later} tasks in later weeks build on this`;
    } else {
      const lead = unlocks.length === 1 ? '1 task waits on this:' : `${unlocks.length} tasks wait on this:`;
      text = `${lead} ${unlocks.map(chip).join('')}${later ? ` <span>and ${later} in later weeks</span>` : ''}`;
    }
    ripple.push(`<div class="ripple"><span class="arrow">→</span> ${text}</div>`);
  }

  const early = plan.early && ['waiting', 'ready', 'unknown'].includes(status)
      ? `<div class="early"><b>Head start:</b> ${fmt(plan.early)}</div>` : '';

  const prs = (live?.prs ?? []).slice().sort((a, b) => (a.state === 'OPEN' ? -1 : 0) - (b.state === 'OPEN' ? -1 : 0));
  const prLines = prs.map((pr) => {
    const label = pr.state === 'OPEN' ? (pr.isDraft ? 'Draft PR' : 'PR open') : pr.state === 'MERGED' ? 'Merged' : 'Closed';
    const cls = pr.state === 'MERGED' ? 's-done' : pr.state === 'OPEN' ? 's-pr' : 's-waiting';
    const notes = ui.plan.prs?.[String(pr.number)]?.bullets;
    return `
      <div class="pr-line"><span class="pill ${cls}"><span class="dot"></span>${label}</span>
        <a href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.number} ${esc(pr.title)}</a>
        ${pr.author ? `<span class="hint">by ${esc(nameOf(pr.author))}</span>` : ''}</div>
      ${notes ? `<ul class="pr-notes">${notes.map((b) => `<li>${fmt(b)}</li>`).join('')}</ul>` : ''}`;
  }).join('');

  return `
    <div class="task" id="task-${number}" data-n="${number}">
      <div class="task-top">
        <div>
          ${stepLabel ? `<div class="task-step">${stepLabel}</div>` : ''}
          <h4 class="task-title"><a href="${esc(url)}" target="_blank" rel="noopener"><span class="num">#${number}</span>${esc(title)}</a></h4>
        </div>
        ${status === 'unknown' ? '' : `<span class="pill s-${status}"><span class="dot"></span>${STATUS_LABEL[status]}</span>`}
      </div>
      <p class="task-headline">${fmt(plan.headline)}</p>
      <ul>${plan.bullets.map((b) => `<li>${fmt(b)}</li>`).join('')}</ul>
      ${early}
      ${ripple.join('')}
      ${prLines}
    </div>`;
}

function chip(number) {
  return `<button class="chip" data-goto="${number}" title="#${number}"><span class="dot s-${statusOf(number)}"></span>${esc(shortName(number))}</button>`;
}

function renderOwner(bundle) {
  const error = ui.errors[bundle.id] ? `<span class="error">${esc(ui.errors[bundle.id])}</span>` : '';
  if (!ui.live || !ui.signedIn) {
    const owners = ownersOf(bundle);
    if (owners.length) {
      return ownerLine(owners, false);
    }
    return `<span class="hint">Nobody yet</span><a class="button quiet" href="/auth/login">Sign in to pick</a>`;
  }

  const owners = ownersOf(bundle);
  const busy = ui.inFlight.has(bundle.id);
  if (!owners.length) {
    return `<span class="hint">${error || (busy ? 'Removing you on GitHub…' : 'Nobody yet')}</span>
      <button class="button" data-action="claim" data-bundle="${esc(bundle.id)}" ${busy ? 'disabled' : ''}>Assign me</button>`;
  }
  const mine = owners.some((o) => o.login === ui.viewer.login);
  if (mine && busy) {
    return `${ownerLine(owners, true)}<span class="syncing"><span class="spinner"></span>Assigning you on GitHub…</span>`;
  }
  return `${ownerLine(owners, mine)}
    ${mine ? `<span>${error}<button class="linkish" data-action="release" data-bundle="${esc(bundle.id)}">Undo</button></span>` : ''}`;
}

function ownerLine(owners, mine) {
  const faces = owners.map((o) => `<img src="${esc(o.avatar)}" alt="">`).join('');
  const names = mine ? 'You have this' : `${owners.map((o) => esc(nameOf(o.login, o.name))).join(' & ')} ${owners.length > 1 ? 'have' : 'has'} this`;
  return `<div class="owner">${faces}<span>${names}</span></div>`;
}

function renderFooter() {
  const refreshed = formatDate(parseDate(ui.plan.refreshed));
  const live = ui.fetchedAt
      ? `Statuses live from GitHub, checked ${new Date(ui.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Statuses need GitHub sign-in';
  const milestoneUrl = `https://github.com/${ui.plan.repo}/milestone/${ui.plan.milestone.number}`;
  document.getElementById('footer').innerHTML = `
    <span>Plan refreshed ${esc(refreshed)} · ${live}</span>
    <a href="${esc(milestoneUrl)}" target="_blank" rel="noopener">${esc(ui.plan.milestone.title)} on GitHub</a>`;
}

//// Actions

async function onClick(event) {
  const goto = event.target.closest('[data-goto]');
  if (goto) {
    goToTask(Number(goto.dataset.goto));
    return;
  }
  const action = event.target.closest('[data-action]');
  if (!action) {
    return;
  }
  if (action.dataset.action === 'signout') {
    await fetch('/auth/logout', { method: 'POST' });
    ui.signedIn = false;
    ui.viewer = null;
    await refresh();
    return;
  }
  if (action.dataset.action === 'view-all' || action.dataset.action === 'view-mine') {
    const view = action.dataset.action === 'view-all' ? 'all' : 'auto';
    animate(() => {
      setView(view);
      render();
      scrollToBundles();
    });
    return;
  }
  const id = action.dataset.bundle;
  if (ui.inFlight.has(id)) {
    return;
  }
  await assign(id, action.dataset.action === 'claim' ? 'claim' : 'release');
}

/**
 * Shows the result straight away (claiming zooms into your bundle) while GitHub is updated in the
 * background. Rolls back with an error if GitHub refuses.
 */
async function assign(bundleId, kind) {
  delete ui.errors[bundleId];
  ui.inFlight.add(bundleId);
  animate(() => {
    ui.optimistic[bundleId] = { kind, until: Infinity };
    if (kind === 'claim') {
      setView('auto');
    }
    render();
    scrollToBundles();
  }, kind === 'claim' ? bundleId : null);

  let error = null;
  try {
    const res = await fetch(`/api/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundle: bundleId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const failed = data.results?.filter((r) => !r.ok).map((r) => `#${r.number}`).join(', ');
      error = failed ? `Couldn't update ${failed}. Try again.` : (data.error || 'Something went wrong.');
    }
  } catch {
    error = 'Network error. Try again.';
  }

  ui.inFlight.delete(bundleId);
  if (error) {
    animate(() => {
      delete ui.optimistic[bundleId];
      ui.errors[bundleId] = error;
      render();
      scrollToBundles();
    });
    return;
  }
  // GitHub can take a moment to report the change, so keep showing it briefly.
  ui.optimistic[bundleId] = { kind, until: Date.now() + 30_000 };
  await refresh();
}

/** Runs a DOM update as an animated view transition when the browser supports it. */
function animate(update, landedBundleId = null) {
  if (!document.startViewTransition || reducedMotion.matches) {
    update();
    return;
  }
  const transition = document.startViewTransition(update);
  if (landedBundleId) {
    transition.finished.then(() => {
      document.querySelector(`.bundle[data-bundle="${CSS.escape(landedBundleId)}"]`)?.classList.add('landed');
    });
  }
}

function scrollToBundles() {
  const block = document.getElementById('bundles-block');
  window.scrollTo({ top: block.getBoundingClientRect().top + window.scrollY - 16, behavior: 'instant' });
}

function loadView() {
  try {
    return localStorage.getItem(`view:${ui.plan.milestone.title}`) === 'all' ? 'all' : 'auto';
  } catch {
    return 'auto';
  }
}

function setView(view) {
  ui.view = view;
  try {
    localStorage.setItem(`view:${ui.plan.milestone.title}`, view);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts only for this visit.
  }
}

function goToTask(number) {
  const task = document.getElementById(`task-${number}`);
  if (!task) {
    return;
  }
  task.scrollIntoView({ behavior: 'smooth', block: 'start' });
  task.classList.add('flash');
  setTimeout(() => task.classList.remove('flash'), 1200);
}

//// Formatting

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(text) {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatDate(date) {
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
