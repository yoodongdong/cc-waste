#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { resolveClaudeHome, findSessionFiles } = await import(path.join(__dirname, '../src/find-logs.js'));
const { parseSessionFile } = await import(path.join(__dirname, '../src/parse-session.js'));
const { aggregateSessions } = await import(path.join(__dirname, '../src/aggregate.js'));
const { renderReport } = await import(path.join(__dirname, '../src/html-report.js'));
const { listInstalledSkills, auditSkills, applyFixes } = await import(path.join(__dirname, '../src/skills-audit.js'));
const { getPricing } = await import(path.join(__dirname, '../src/pricing.js'));

function parseArgs(argv) {
  const args = { out: 'cc-waste-report.html', dir: null, days: null, project: null, json: false, open: true, fix: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out':
      case '-o':
        args.out = argv[++i];
        break;
      case '--dir':
        args.dir = argv[++i];
        break;
      case '--days':
        args.days = Number(argv[++i]);
        break;
      case '--project':
        args.project = argv[++i];
        break;
      case '--json':
        args.json = true;
        break;
      case '--open':
        args.open = true;
        break;
      case '--no-open':
        args.open = false;
        break;
      case '--fix':
        args.fix = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.error(`알 수 없는 인자: ${a}`);
        args.help = true;
    }
  }
  return args;
}

// Reconstructs the exact command the user should copy-paste to re-run this
// scan with --fix, carrying over whatever --dir/--project/--days/--out they
// already used so the suggestion actually matches what they just did.
function buildFixCommand(args) {
  const parts = ['npx cc-waste --fix'];
  if (args.dir) parts.push(`--dir "${args.dir}"`);
  if (args.project) parts.push(`--project "${args.project}"`);
  if (args.days) parts.push(`--days ${args.days}`);
  if (args.out !== 'cc-waste-report.html') parts.push(`--out "${args.out}"`);
  return parts.join(' ');
}

function printHelp() {
  console.log(`cc-waste — 로컬 Claude Code 토큰 사용량 + 낭비 리포트

사용법:
  npx cc-waste [options]

옵션:
  -o, --out <file>     출력 HTML 경로 (기본값: ./cc-waste-report.html)
  --dir <path>         스캔할 Claude 설정 디렉터리 (기본값: $CLAUDE_CONFIG_DIR 또는 ~/.claude)
  --days <n>           최근 N일 이내 활동만 포함
  --project <substr>   폴더 이름에 이 문자열이 포함된 프로젝트만 포함
  --json               원본 집계 데이터를 .json 파일로도 저장
  --no-open            완료 후 브라우저를 자동으로 열지 않음 (기본값: 자동으로 열림)
  --fix                거의/전혀 사용하지 않는 스킬을 skills-disabled/ 로 옮겨 자동 비활성화
                        (삭제하지 않음, 언제든 수동으로 복원 가능)
  -h, --help             도움말 표시

토큰 사용량/비용 분석과 함께 ~/.claude/skills 에 설치된 스킬 중 스캔한 세션에서
거의/전혀 호출되지 않은 것도 함께 찾아 리포트에 표시합니다. --fix를 주면 그 스킬들을
실제로 비활성화하고, 무엇을 어떻게 처리했는지 리포트에 그대로 남깁니다.

100% 로컬 동작: 로컬 Claude Code 세션 로그(~/.claude/projects/**/*.jsonl)만 읽습니다.
네트워크 호출이 없으며 어디로도 전송되지 않습니다.
`);
}

function openInBrowser(filePath) {
  const url = 'file://' + filePath;
  const platform = process.platform;
  let cmd;
  let cmdArgs;
  if (platform === 'darwin') {
    cmd = 'open';
    cmdArgs = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    cmdArgs = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    cmdArgs = [url];
  }
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    // Headless/CI machines often lack xdg-open etc. — that failure arrives
    // async via 'error', not a thrown exception, and an unhandled 'error'
    // event on a ChildProcess crashes the process if we don't listen here.
    child.on('error', () => {
      console.error(`브라우저를 자동으로 열지 못했습니다. 직접 열어주세요: ${filePath}`);
    });
    child.unref();
  } catch {
    console.error(`브라우저를 자동으로 열지 못했습니다. 직접 열어주세요: ${filePath}`);
  }
}

function printSummary(aggregate, outPath) {
  const { totals, waste, skillsAudit } = aggregate;
  console.log('');
  console.log(`스캔한 세션:        ${totals.sessionCount}개 (프로젝트 ${totals.projectCount}개)`);
  console.log(`총 토큰:            ${Math.round(totals.totalTokens).toLocaleString('en-US')}`);
  console.log(`예상 비용:          $${totals.cost.toFixed(2)} (정가 기준, Anthropic Console에서 확인하세요)`);
  console.log(`캐시 적중률:        ${totals.cacheHitRate === null ? '—' : Math.round(totals.cacheHitRate * 100) + '%'}`);
  console.log(`낭비 추정:          ~${Math.round(waste.estTokens).toLocaleString('en-US')} 토큰 (~$${waste.estCost.toFixed(2)}), ${waste.findingCount}건`);
  if (skillsAudit && skillsAudit.installedCount > 0) {
    console.log(`설치된 스킬:        ${skillsAudit.installedCount}개 (저활용 ${skillsAudit.flaggedCount}개)`);
    if (skillsAudit.fixApplied) {
      console.log(`자동 비활성화:      ${skillsAudit.fixActions.length}개 (skills-disabled/ 로 이동, 복원 명령은 리포트 참고)`);
    }
  }
  console.log('');
  console.log(`리포트 저장 위치:   ${path.resolve(outPath)}`);

  if (skillsAudit && skillsAudit.flaggedCount > 0 && !skillsAudit.fixApplied) {
    console.log('');
    console.log(`거의/전혀 안 쓰는 스킬 ${skillsAudit.flaggedCount}개를 정리하려면 아래 명령어를 실행하세요:`);
    console.log('');
    console.log(`  ${skillsAudit.fixCommand}`);
    console.log('');
    console.log('(삭제가 아니라 skills-disabled/ 로 옮기는 것이라 언제든 되돌릴 수 있습니다.)');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const claudeHome = args.dir || resolveClaudeHome();
  let sessionRefs = findSessionFiles(claudeHome);
  if (args.project) {
    sessionRefs = sessionRefs.filter((s) => s.projectSlug.includes(args.project));
  }

  if (sessionRefs.length === 0) {
    console.error(`${path.join(claudeHome, 'projects')} 아래에서 Claude Code 세션 로그를 찾지 못했습니다.`);
    console.error('--dir로 다른 Claude 설정 디렉터리를 지정하거나, --project로 필터를 넓혀보세요.');
    process.exitCode = 1;
    return;
  }

  console.log(`${claudeHome} 아래 세션 파일 ${sessionRefs.length}개를 스캔합니다 ...`);

  const sinceMs = args.days ? Date.now() - args.days * 86400000 : null;
  const sessions = [];
  for (const ref of sessionRefs) {
    let session;
    try {
      session = await parseSessionFile(ref.filePath, ref.projectSlug);
    } catch (err) {
      console.error(`읽을 수 없는 세션 파일을 건너뜁니다 ${ref.filePath}: ${err.message}`);
      continue;
    }
    if (sinceMs && session.endTime && new Date(session.endTime).getTime() < sinceMs) continue;
    sessions.push(session);
  }

  if (sessions.length === 0) {
    console.error('주어진 필터와 일치하는 세션이 없습니다.');
    process.exitCode = 1;
    return;
  }

  const aggregate = aggregateSessions(sessions, claudeHome);

  const installedSkills = listInstalledSkills(claudeHome);
  const skillFindings = auditSkills(installedSkills, aggregate.skillCallCounts, sessions.length);

  let fixActions = [];
  if (args.fix && skillFindings.length > 0) {
    console.log(`저활용 스킬 ${skillFindings.length}개를 비활성화하는 중 ...`);
    fixActions = applyFixes(claudeHome, skillFindings);
  }

  const skillWasteRate = getPricing(aggregate.dominantModel).input;
  for (const f of skillFindings) {
    aggregate.findings.push({
      ...f,
      project: '(전역 스킬)',
      sessionId: null,
      sessionFile: null,
      timestamp: aggregate.totals.to,
      estCostSaved: f.estTokens ? (f.estTokens / 1e6) * skillWasteRate : 0,
    });
  }
  aggregate.findings.sort((a, b) => (b.estTokens || 0) - (a.estTokens || 0));
  aggregate.waste = {
    findingCount: aggregate.findings.length,
    estTokens: aggregate.findings.reduce((sum, f) => sum + (f.estTokens || 0), 0),
    estCost: aggregate.findings.reduce((sum, f) => sum + (f.estCostSaved || 0), 0),
  };
  aggregate.skillsAudit = {
    installedCount: installedSkills.length,
    flaggedCount: skillFindings.length,
    fixApplied: args.fix,
    fixActions,
    fixCommand: buildFixCommand(args),
  };
  // Map isn't useful past this point and doesn't serialize meaningfully to JSON.
  aggregate.skillCallCounts = Object.fromEntries(aggregate.skillCallCounts);

  const html = renderReport(aggregate);
  fs.writeFileSync(args.out, html, 'utf8');

  if (args.json) {
    const jsonPath = args.out.replace(/\.html$/i, '') + '.json';
    fs.writeFileSync(jsonPath, JSON.stringify(aggregate, null, 2), 'utf8');
    console.log(`원본 데이터 저장 위치: ${path.resolve(jsonPath)}`);
  }

  printSummary(aggregate, args.out);

  if (args.open) {
    openInBrowser(path.resolve(args.out));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
