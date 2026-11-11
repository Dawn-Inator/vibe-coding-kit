const value = (row, key) => String(row?.[key] ?? '').trim();
const isTracking = (row) => /^tracking\b/i.test(value(row, 'status'));

/** Validate optional parent tracking rows and their child graph. */
export function checkTrackingRows(rows = []) {
  const findings = [];
  const ids = new Set(rows.map((row) => value(row, 'id')).filter(Boolean));
  const graph = new Map();
  const add = (rule, row, detail) => findings.push({
    severity: 'error',
    rule,
    message: `item ${value(row, 'id') || '(no id)'} (line ${row.line ?? '?'}): ${detail}`,
  });

  for (const row of rows.filter(isTracking)) {
    const id = value(row, 'id');
    for (const key of ['owner', 'repository', 'worktree']) {
      if (!value(row, key)) add('tracking-parent-metadata', row, `tracking parent needs a nonempty ${key}`);
    }
    if (value(row, 'mode').toLowerCase() !== 'read-only') add('tracking-parent-mode', row, 'tracking parent mode must be read-only');
    let writeSet;
    try { writeSet = JSON.parse(value(row, 'write_set')); }
    catch { writeSet = null; }
    if (!Array.isArray(writeSet) || writeSet.length !== 0) add('tracking-parent-write-set', row, 'tracking parent write_set must be []');
    if (value(row, 'dispatch_ref') && value(row, 'dispatch_ref') !== '-') add('tracking-parent-dispatch-ref', row, 'tracking parent dispatch_ref must be empty or -');

    let children;
    try { children = JSON.parse(value(row, 'children')); }
    catch { children = null; }
    if (!Array.isArray(children) || children.length === 0 || children.some((child) => typeof child !== 'string' || !child.trim())) {
      add('tracking-children-json', row, 'tracking parent children must be a nonempty JSON array of child IDs');
      graph.set(id, []);
      continue;
    }
    const seen = new Set();
    const validChildren = [];
    for (const childRaw of children) {
      const child = childRaw.trim();
      if (seen.has(child)) add('tracking-child-duplicate', row, `child ${child} appears more than once`);
      seen.add(child);
      if (!ids.has(child)) add('tracking-child-unknown', row, `child ${child} does not exist in the Items registry`);
      if (child === id) add('tracking-child-self', row, 'tracking parent cannot list itself as a child');
      if (ids.has(child) && child !== id) validChildren.push(child);
    }
    graph.set(id, validChildren);
  }

  const trackingIds = new Set(rows.filter(isTracking).map((row) => value(row, 'id')).filter(Boolean));
  const state = new Map();
  const cycleReported = new Set();
  const visit = (id, stack) => {
    state.set(id, 1);
    for (const child of graph.get(id) ?? []) {
      if (!trackingIds.has(child)) continue;
      if (state.get(child) === 1) {
        const cycle = [...stack, id, child].join(' -> ');
        const key = [...new Set([...stack, id, child])].sort().join('|');
        if (!cycleReported.has(key)) {
          cycleReported.add(key);
          const row = rows.find((entry) => value(entry, 'id') === id);
          add('tracking-child-cycle', row, `tracking parent graph contains a cycle: ${cycle}`);
        }
      } else if (!state.has(child)) visit(child, [...stack, id]);
    }
    state.set(id, 2);
  };
  for (const id of trackingIds) if (!state.has(id)) visit(id, []);
  return findings;
}

export function isTrackingItemState(status) { return isTracking({ status }); }
