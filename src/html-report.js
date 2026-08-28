const FINDING_LABELS = {
  'large-tool-result': { label: '거대한 tool 결과', hint: '다음엔 limit/offset, head_limit, 또는 더 좁은 필터를 지정하세요.' },
  'repeated-full-read': { label: '동일 파일 반복 읽기', hint: '한 번만 읽고 컨텍스트에 유지하거나, 특정 부분만 필요하면 Grep을 사용하세요.' },
  'large-user-paste': { label: '큰 붙여넣기', hint: '전체 내용을 프롬프트에 붙여넣는 대신 파일 경로를 참조하세요.' },
  'low-cache-hit-rate': { label: '낮은 프롬프트 캐시 적중률', hint: '세션 중 시스템 프롬프트/도구 구성이 자주 바뀌면 캐싱이 깨집니다 — 세션 내에서 컨텍스트를 안정적으로 유지하세요.' },
  'unused-skill': { label: '미사용 스킬', hint: '스캔한 세션에서 한 번도 호출되지 않았습니다 — 설치되어 있는 것만으로 매 세션 카탈로그 토큰을 소모합니다.' },
  'rarely-used-skill': { label: '거의 사용 안 하는 스킬', hint: '호출 빈도가 매우 낮습니다 — 카탈로그 유지 비용 대비 활용도가 낮습니다.' },
};

const VISIBLE_ROWS = 10;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function fmtNum(n) {
  return Math.round(n || 0).toLocaleString('en-US');
}

function fmtTokens(n) {
  const v = n || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

function fmtCost(n) {
  return '$' + (n || 0).toFixed(2);
}

function fmtPct(n) {
  return n === null || n === undefined ? '—' : Math.round(n * 100) + '%';
}

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16) + ' UTC';
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : '—';
}

// Collapses a long row list down to VISIBLE_ROWS with a "N개 더보기" toggle
// row that expands the rest client-side (see ccWasteToggleMore in the page
// script) — avoids either dumping everything (endless scroll) or silently
// hiding data behind a "see --json" footnote.
function paginateRows(rows, colSpan) {
  if (rows.length <= VISIBLE_ROWS) return rows.join('');
  const visible = rows.slice(0, VISIBLE_ROWS).join('');
  const hiddenCount = rows.length - VISIBLE_ROWS;
  const hidden = rows
    .slice(VISIBLE_ROWS)
    .map((r) => r.replace('<tr>', '<tr class="cc-more-row" style="display:none">'))
    .join('');
  const label = `${hiddenCount}개 더보기`;
  const toggleRow = `<tr class="cc-more-toggle-row"><td colspan="${colSpan}" class="more-cell"><button type="button" class="more-btn" data-label="${escapeHtml(label)}" onclick="ccWasteToggleMore(this)">${escapeHtml(label)}</button></td></tr>`;
  return visible + hidden + toggleRow;
}

function card(label, value, sub) {
  return `<div class="card">
    <div class="card-label">${escapeHtml(label)}</div>
    <div class="card-value">${value}</div>
    ${sub ? `<div class="card-sub">${sub}</div>` : ''}
  </div>`;
}

function renderDayChart(perDay) {
  if (perDay.length === 0) return '<p class="empty">날짜별 활동 데이터가 없습니다.</p>';
  const max = Math.max(...perDay.map((d) => d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens), 1);
  const bars = perDay
    .map((d) => {
      const total = d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
      const heightPct = Math.max(2, Math.round((total / max) * 100));
      return `<div class="bar-col" title="${escapeHtml(d.date)}: ${fmtTokens(total)} 토큰, ${fmtCost(d.cost)}">
        <div class="bar" style="height:${heightPct}%"></div>
        <div class="bar-label">${escapeHtml(d.date.slice(5))}</div>
      </div>`;
    })
    .join('');
  return `<div class="bar-chart">${bars}</div>`;
}

function renderModelTable(perModel) {
  if (perModel.length === 0) return '<p class="empty">기록된 사용량이 없습니다.</p>';
  const rows = perModel
    .map(
      (m) => `<tr>
      <td>${escapeHtml(m.model)}</td>
      <td class="num">${fmtTokens(m.inputTokens)}</td>
      <td class="num">${fmtTokens(m.outputTokens)}</td>
      <td class="num">${fmtTokens(m.cacheCreationTokens)}</td>
      <td class="num">${fmtTokens(m.cacheReadTokens)}</td>
      <td class="num">${fmtCost(m.cost)}</td>
    </tr>`
    )
    .join('');
  return `<table>
    <thead><tr><th>모델</th><th class="num">입력</th><th class="num">출력</th><th class="num">캐시 생성</th><th class="num">캐시 읽기</th><th class="num">예상 비용</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderProjectTable(perProject) {
  if (perProject.length === 0) return '<p class="empty">프로젝트를 찾지 못했습니다.</p>';
  const rows = perProject.map(
    (p) => `<tr>
      <td>${escapeHtml(p.project)}</td>
      <td class="num">${p.sessionCount}</td>
      <td class="num">${fmtTokens(p.inputTokens + p.outputTokens + p.cacheCreationTokens + p.cacheReadTokens)}</td>
      <td class="num">${fmtCost(p.cost)}</td>
    </tr>`
  );
  return `<table>
    <thead><tr><th>프로젝트</th><th class="num">세션 수</th><th class="num">총 토큰</th><th class="num">예상 비용</th></tr></thead>
    <tbody>${paginateRows(rows, 4)}</tbody>
  </table>`;
}

function renderFindings(findings) {
  if (findings.length === 0) {
    return '<p class="empty">눈에 띄는 낭비 패턴이 없습니다 — 깔끔하네요.</p>';
  }
  const rows = findings.map((f) => {
    const meta = FINDING_LABELS[f.type] || { label: f.type, hint: '' };
    return `<tr>
        <td><span class="badge badge-${escapeHtml(f.type)}">${escapeHtml(meta.label)}</span></td>
        <td>${escapeHtml(f.project)}</td>
        <td class="mono">${escapeHtml(f.detail)}</td>
        <td class="num">${f.estTokens ? '~' + fmtTokens(f.estTokens) : '—'}</td>
        <td class="num">${f.estCostSaved ? fmtCost(f.estCostSaved) : '—'}</td>
        <td class="dim">${escapeHtml(fmtDate(f.timestamp))}</td>
      </tr>`;
  });
  return `<table>
    <thead><tr><th>패턴</th><th>프로젝트</th><th>상세</th><th class="num">~토큰</th><th class="num">~비용</th><th>시점</th></tr></thead>
    <tbody>${paginateRows(rows, 6)}</tbody>
  </table>`;
}

function renderLegend() {
  const items = Object.entries(FINDING_LABELS)
    .map(([type, meta]) => `<li><span class="badge badge-${type}">${escapeHtml(meta.label)}</span> ${escapeHtml(meta.hint)}</li>`)
    .join('');
  return `<ul class="legend">${items}</ul>`;
}

function renderSkillsAudit(findings, skillsAudit) {
  if (!skillsAudit || skillsAudit.installedCount === 0) {
    return '<p class="empty">이 머신에 설치된 스킬(~/.claude/skills)을 찾지 못했습니다.</p>';
  }

  const skillFindings = findings.filter((f) => f.type === 'unused-skill' || f.type === 'rarely-used-skill');

  if (skillFindings.length === 0) {
    return `<p class="empty">설치된 스킬 ${skillsAudit.installedCount}개 모두 정상적으로 사용되고 있습니다.</p>`;
  }

  const rows = skillFindings.map((f) => {
    const meta = FINDING_LABELS[f.type];
    let actionCell = '<span class="dim">조치 안 함</span>';
    if (f.hookProtected) actionCell = '<span class="badge badge-protected">보호됨 (hook 연결)</span> <span class="dim">자동 비활성화 대상에서 제외</span>';
    else if (f.fixed === true) actionCell = '<span class="badge badge-fixed">✓ 비활성화됨</span>';
    else if (f.fixed === false) actionCell = `<span class="badge badge-fix-failed">해결 실패</span> <span class="dim">${escapeHtml(f.fixDetail || '')}</span>`;
    return `<tr>
        <td class="mono">${escapeHtml(f.skillName)}</td>
        <td><span class="badge badge-${escapeHtml(f.type)}">${escapeHtml(meta.label)}</span></td>
        <td class="num">${f.calls}</td>
        <td class="num">~${fmtTokens(f.estTokens)}</td>
        <td>${actionCell}</td>
      </tr>`;
  });

  const table = `<table>
    <thead><tr><th>스킬</th><th>상태</th><th class="num">호출 횟수</th><th class="num">~예상 낭비 토큰</th><th>조치</th></tr></thead>
    <tbody>${paginateRows(rows, 5)}</tbody>
  </table>`;

  let fixSection;
  if (skillsAudit.fixApplied) {
    if (skillsAudit.fixActions.length > 0) {
      const actionRows = skillsAudit.fixActions.map(
        (a) => `<tr>
        <td class="mono">${escapeHtml(a.skill)}</td>
        <td class="mono">${escapeHtml(a.to)}</td>
        <td class="mono">mv "${escapeHtml(a.to)}" "${escapeHtml(a.from)}"</td>
      </tr>`
      );
      fixSection = `<h3>자동 해결 내역</h3>
      <p class="dim">위 스킬들을 <code>skills-disabled/</code>로 옮겨 비활성화했습니다 (삭제 아님). 되돌리려면 마지막 열의 명령을 실행하세요.</p>
      <table>
        <thead><tr><th>스킬</th><th>이동된 위치</th><th>복원 명령</th></tr></thead>
        <tbody>${paginateRows(actionRows, 3)}</tbody>
      </table>`;
    } else {
      fixSection = '<p class="empty"><code>--fix</code>가 지정되었지만 실제로 옮긴 항목은 없습니다 (이미 비활성화되어 있었을 수 있습니다).</p>';
    }
  } else {
    fixSection = `<div class="callout">
      <div>아래 명령어를 실행하면 위 스킬들을 자동으로 비활성화합니다 (삭제하지 않고 이동, 언제든 복원 가능).</div>
      <div class="callout-cmd-row">
        <div class="callout-cmd">${escapeHtml(skillsAudit.fixCommand)}</div>
        <button type="button" class="copy-btn" data-copy="${escapeHtml(skillsAudit.fixCommand)}" onclick="ccWasteCopy(this)">Copy</button>
      </div>
    </div>`;
  }

  return table + fixSection;
}

export function renderReport(data) {
  const { totals, waste, perModel, perProject, perDay, findings, claudeHome, generatedAt, skillsAudit } = data;

  const rangeStr = totals.from && totals.to ? `${fmtDate(totals.from)} → ${fmtDate(totals.to)}` : '날짜별 활동 데이터 없음';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code 사용량 및 낭비 리포트</title>
<style>
  :root {
    --bg: #f7f7f8;
    --surface: #ffffff;
    --border: #e3e3e6;
    --text: #1b1b1f;
    --text-dim: #6b6b74;
    --accent: #c15f3c;
    --accent-soft: #f3e4dd;
    --warn: #b0472b;
    --good: #3b7a57;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16161a;
      --surface: #1e1e23;
      --border: #303038;
      --text: #ececf0;
      --text-dim: #97979f;
      --accent: #e08a63;
      --accent-soft: #3a2a22;
      --warn: #e08a63;
      --good: #6bb98d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    padding: 32px 20px 60px;
  }
  .wrap { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 36px 0 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
  h3 { font-size: 13px; margin: 20px 0 8px; color: var(--text); }
  .meta { color: var(--text-dim); font-size: 13px; }
  .meta code { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 20px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card-label { color: var(--text-dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
  .card-value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .card-sub { color: var(--text-dim); font-size: 12px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { padding: 8px 12px; border-bottom: 1px solid var(--border); text-align: left; font-size: 13px; }
  th { color: var(--text-dim); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.02em; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .dim { color: var(--text-dim); font-size: 12px; }
  .empty { color: var(--text-dim); font-style: italic; padding: 10px 2px; }
  .bar-chart { display: flex; align-items: flex-end; gap: 4px; height: 140px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 12px 6px; overflow-x: auto; }
  .bar-col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; min-width: 16px; flex: 1; height: 100%; }
  .bar { width: 100%; max-width: 20px; background: var(--accent); border-radius: 3px 3px 0 0; }
  .bar-label { font-size: 10px; color: var(--text-dim); margin-top: 4px; writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--accent-soft); color: var(--warn); white-space: nowrap; }
  .badge-fixed { background: transparent; color: var(--good); border: 1px solid var(--good); }
  .badge-fix-failed { background: transparent; color: var(--warn); border: 1px solid var(--warn); }
  .badge-protected { background: transparent; color: var(--text-dim); border: 1px solid var(--text-dim); }
  .legend { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; color: var(--text-dim); font-size: 12px; }
  .legend .badge { margin-right: 6px; }
  .callout { border: 1px solid var(--accent); background: var(--accent-soft); border-radius: 10px; padding: 12px 16px; margin-top: 10px; font-size: 13px; }
  .callout-cmd-row { display: flex; align-items: stretch; gap: 8px; margin-top: 8px; }
  .callout-cmd { flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; overflow-x: auto; white-space: pre; }
  .copy-btn { flex-shrink: 0; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 6px; padding: 0 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .copy-btn:hover { background: var(--accent-soft); border-color: var(--accent); }
  .more-cell { text-align: center; padding: 10px; }
  .cc-more-toggle-row td { border-bottom: none; }
  .more-btn { border: 1px solid var(--border); background: var(--surface); color: var(--accent); border-radius: 6px; padding: 6px 18px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .more-btn:hover { background: var(--accent-soft); border-color: var(--accent); }
  footer { margin-top: 48px; color: var(--text-dim); font-size: 12px; border-top: 1px solid var(--border); padding-top: 16px; }
  .credit { margin-top: 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .kofi-btn { display: inline-block; background: #ff5e5b; color: #fff; font-weight: 700; font-size: 11px; padding: 5px 12px; border-radius: 6px; text-decoration: none; }
  .kofi-btn:hover { background: #e8514e; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Claude Code 사용량 및 낭비 리포트</h1>
  <div class="meta">
    ${escapeHtml(fmtDate(generatedAt))} 생성 · <code>${escapeHtml(claudeHome)}</code> 스캔 · 활동 기간 ${escapeHtml(rangeStr)}
  </div>

  <div class="cards">
    ${card('총 토큰', fmtTokens(totals.totalTokens), `세션 ${fmtNum(totals.sessionCount)}개 · 프로젝트 ${fmtNum(totals.projectCount)}개`)}
    ${card('예상 비용', fmtCost(totals.cost), '정가 기준 추정치, Console에서 확인하세요')}
    ${card('캐시 적중률', fmtPct(totals.cacheHitRate), '캐시에서 제공된 입력 토큰 비율')}
    ${card('낭비 추정 토큰', '~' + fmtTokens(waste.estTokens), `발견 ${fmtNum(waste.findingCount)}건`)}
    ${card('낭비 추정 비용', '~' + fmtCost(waste.estCost), '휴리스틱 추정치, 정확하지 않음')}
    ${skillsAudit && skillsAudit.installedCount > 0 ? card('설치된 스킬', `${fmtNum(skillsAudit.installedCount)}개`, `저활용 ${fmtNum(skillsAudit.flaggedCount)}개${skillsAudit.fixApplied ? ` · ${fmtNum(skillsAudit.fixActions.length)}개 비활성화됨` : ''}`) : ''}
  </div>

  <h2>일별 토큰 사용량</h2>
  ${renderDayChart(perDay)}

  <h2>모델별</h2>
  ${renderModelTable(perModel)}

  <h2>프로젝트별</h2>
  ${renderProjectTable(perProject)}

  <h2>토큰 낭비 추정</h2>
  ${renderLegend()}
  <div style="margin-top:12px">${renderFindings(findings)}</div>

  <h2>설치된 스킬 감사</h2>
  ${renderSkillsAudit(findings, skillsAudit)}

  <footer>
    휴리스틱 기반 추정치입니다 — 토큰당 약 4자, 모델군별 정가 기준으로 계산했습니다. 이 리포트는 로컬 Claude Code
    세션 로그만으로 생성되었으며, 어떤 내용도 외부로 전송되지 않았습니다. 이 페이지의 원본 수치가 필요하면
    <code>--json</code> 옵션을 함께 실행하세요.
    <div class="credit">
      <span>cc-waste, made by slow.wave</span>
      <a class="kofi-btn" href="https://ko-fi.com/slowwave" target="_blank" rel="noopener">Ko-fi로 후원하기</a>
    </div>
  </footer>
</div>
<script>
  function ccWasteCopy(btn) {
    var text = btn.getAttribute('data-copy');
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else {
      fallback();
    }
    var original = btn.textContent;
    btn.textContent = 'Copied!';
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = original;
      btn.disabled = false;
    }, 1500);
  }

  function ccWasteToggleMore(btn) {
    var tbody = btn.closest('tbody');
    var hiddenRows = tbody.querySelectorAll('.cc-more-row');
    var isCollapsed = hiddenRows.length > 0 && hiddenRows[0].style.display === 'none';
    for (var i = 0; i < hiddenRows.length; i++) {
      hiddenRows[i].style.display = isCollapsed ? '' : 'none';
    }
    btn.textContent = isCollapsed ? '접기' : btn.getAttribute('data-label');
  }
</script>
</body>
</html>
`;
}
