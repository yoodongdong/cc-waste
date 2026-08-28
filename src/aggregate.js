import { estimateCost, getPricing } from './pricing.js';

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0 };
}

function addUsage(target, delta) {
  target.inputTokens += delta.inputTokens || 0;
  target.outputTokens += delta.outputTokens || 0;
  target.cacheCreationTokens += delta.cacheCreationTokens || 0;
  target.cacheReadTokens += delta.cacheReadTokens || 0;
}

function cacheHitRate(usage) {
  const denom = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  return denom > 0 ? usage.cacheReadTokens / denom : null;
}

function dominantModel(perModelMap) {
  let best = null;
  let bestTokens = -1;
  for (const [model, u] of perModelMap) {
    const total = u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
    if (total > bestTokens) {
      bestTokens = total;
      best = model;
    }
  }
  return best;
}

export function aggregateSessions(sessions, claudeHome) {
  const totals = emptyUsage();
  const perModelMap = new Map();
  const perProjectMap = new Map();
  const perDayMap = new Map();
  const skillCallCounts = new Map();
  const findings = [];
  let earliest = null;
  let latest = null;

  for (const session of sessions) {
    let sessionCost = 0;
    for (const [model, u] of session.perModel) {
      sessionCost += estimateCost(u, model);
    }

    addUsage(totals, session.usage);
    totals.cost += sessionCost;

    for (const [model, u] of session.perModel) {
      if (!perModelMap.has(model)) perModelMap.set(model, emptyUsage());
      const m = perModelMap.get(model);
      addUsage(m, u);
      m.cost += estimateCost(u, model);
    }

    if (!perProjectMap.has(session.projectSlug)) {
      perProjectMap.set(session.projectSlug, { ...emptyUsage(), sessionCount: 0 });
    }
    const proj = perProjectMap.get(session.projectSlug);
    proj.sessionCount++;
    addUsage(proj, session.usage);
    proj.cost += sessionCost;

    if (session.startTime) {
      const day = session.startTime.slice(0, 10);
      if (!perDayMap.has(day)) perDayMap.set(day, emptyUsage());
      const d = perDayMap.get(day);
      addUsage(d, session.usage);
      d.cost += sessionCost;
      if (!earliest || session.startTime < earliest) earliest = session.startTime;
      if (!latest || session.endTime > latest) latest = session.endTime;
    }

    if (session.skillInvocations) {
      for (const [skillName, count] of session.skillInvocations) {
        skillCallCounts.set(skillName, (skillCallCounts.get(skillName) || 0) + count);
      }
    }

    const model = dominantModel(session.perModel);
    const inputRate = getPricing(model).input;
    for (const f of session.findings) {
      findings.push({
        ...f,
        project: session.projectSlug,
        sessionId: session.sessionId,
        sessionFile: session.filePath,
        estCostSaved: f.estTokens ? (f.estTokens / 1e6) * inputRate : 0,
      });
    }
  }

  findings.sort((a, b) => (b.estTokens || 0) - (a.estTokens || 0));

  const totalWastedTokens = findings.reduce((sum, f) => sum + (f.estTokens || 0), 0);
  const totalWastedCost = findings.reduce((sum, f) => sum + (f.estCostSaved || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    claudeHome,
    totals: {
      ...totals,
      totalTokens: totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens,
      sessionCount: sessions.length,
      projectCount: perProjectMap.size,
      from: earliest,
      to: latest,
      cacheHitRate: cacheHitRate(totals),
    },
    waste: {
      findingCount: findings.length,
      estTokens: totalWastedTokens,
      estCost: totalWastedCost,
    },
    perModel: [...perModelMap.entries()]
      .map(([model, u]) => ({ model, ...u }))
      .sort((a, b) => b.cost - a.cost),
    perProject: [...perProjectMap.entries()]
      .map(([project, u]) => ({ project, ...u }))
      .sort((a, b) => b.cost - a.cost),
    perDay: [...perDayMap.entries()]
      .map(([date, u]) => ({ date, ...u }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    findings,
    skillCallCounts,
    dominantModel: dominantModel(perModelMap),
  };
}
