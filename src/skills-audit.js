import fs from 'node:fs';
import path from 'node:path';

const CHARS_PER_TOKEN = 4;

// Only flag a skill as "unused" or "rarely used" once we've scanned enough
// sessions to trust the signal — a handful of logs proves nothing either way.
const MIN_SESSIONS_FOR_UNUSED = 5;
const MIN_SESSIONS_FOR_RARE = 10;
const RARE_CALL_THRESHOLD = 1; // 0 calls => unused; 1 call over MIN_SESSIONS_FOR_RARE sessions => rarely used

function estimateTokens(chars) {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function readFrontmatterField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (!match) return '';
  return match[1].trim().replace(/^["']|["']$/g, '');
}

// Mirrors the discovery shape every host loads each session: a skill's
// name + description sit in the catalog whether or not it's ever invoked.
export function listInstalledSkills(claudeHome) {
  const skillsDir = path.join(claudeHome, 'skills');
  const results = [];
  if (!fs.existsSync(skillsDir)) return results;

  for (const entry of fs.readdirSync(skillsDir)) {
    const dirPath = path.join(skillsDir, entry);
    let stat;
    try {
      stat = fs.statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const skillMdPath = path.join(dirPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    let content;
    try {
      content = fs.readFileSync(skillMdPath, 'utf8');
    } catch {
      continue;
    }

    const name = readFrontmatterField(content, 'name') || entry;
    const description = readFrontmatterField(content, 'description');

    results.push({
      name,
      dirName: entry,
      dirPath,
      description,
      catalogTokens: estimateTokens(name.length + description.length),
    });
  }
  return results;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Claude Code settings.json can wire a hook's "command" straight to a file
// inside a skill's own folder (e.g. a Stop hook shipped by the skill). Moving
// that folder out from under skills/ silently breaks the hook — every future
// turn fails with "No such file or directory" — even though nothing was
// deleted. Recursively pulling every string out of settings.json/
// settings.local.json (global + per project) and substring-matching against
// each skill's path is schema-agnostic: it doesn't need to know the exact
// shape of the hooks config, just that a reference exists somewhere in it.
function collectStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) collectStrings(value[key], out);
  }
}

export function findHookProtectedSkillNames(claudeHome, projectDirs, installedSkills) {
  const settingsPaths = [path.join(claudeHome, 'settings.json'), path.join(claudeHome, 'settings.local.json')];
  for (const dir of projectDirs) {
    if (!dir) continue;
    settingsPaths.push(path.join(dir, '.claude', 'settings.json'));
    settingsPaths.push(path.join(dir, '.claude', 'settings.local.json'));
  }

  const strings = [];
  for (const settingsPath of settingsPaths) {
    if (!fs.existsSync(settingsPath)) continue;
    const json = readJsonSafe(settingsPath);
    if (json) collectStrings(json, strings);
  }
  // Normalize to forward slashes so this matches regardless of whether the
  // settings file stores Windows backslash paths or POSIX-style ones.
  const normalized = strings.map((s) => s.replace(/\\/g, '/'));

  const protectedNames = new Set();
  for (const skill of installedSkills) {
    const marker = `/skills/${skill.dirName}/`;
    if (normalized.some((s) => s.includes(marker))) {
      protectedNames.add(skill.name);
    }
  }
  return protectedNames;
}

// Pure — no filesystem writes. Returns waste-style findings for skills that
// look unused or rarely used, given how many sessions we actually scanned.
// hookProtectedNames marks findings --fix must not act on (see applyFixes).
export function auditSkills(installedSkills, skillCallCounts, sessionCount, hookProtectedNames) {
  const findings = [];
  const protectedNames = hookProtectedNames || new Set();

  for (const skill of installedSkills) {
    const calls = skillCallCounts.get(skill.name) || 0;
    let type = null;

    if (calls === 0 && sessionCount >= MIN_SESSIONS_FOR_UNUSED) {
      type = 'unused-skill';
    } else if (calls > 0 && calls <= RARE_CALL_THRESHOLD && sessionCount >= MIN_SESSIONS_FOR_RARE) {
      type = 'rarely-used-skill';
    }
    if (!type) continue;

    findings.push({
      type,
      skillName: skill.name,
      skillDirPath: skill.dirPath,
      skillDirName: skill.dirName,
      detail: `${skill.name} — 호출 ${calls}회 / 스캔한 세션 ${sessionCount}개`,
      calls,
      // Approximation: this skill's catalog entry rides along on every
      // scanned session regardless of whether it gets invoked.
      estTokens: skill.catalogTokens * sessionCount,
      hookProtected: protectedNames.has(skill.name),
    });
  }

  return findings;
}

// Filesystem write: moves one skill folder out of skills/ into
// skills-disabled/, preserving it (never deletes) so it can be restored
// with a plain `mv` back to its original path.
export function disableSkill(claudeHome, skillFinding) {
  const disabledDir = path.join(claudeHome, 'skills-disabled');
  const target = path.join(disabledDir, skillFinding.skillDirName);

  if (fs.existsSync(target)) {
    return { ok: false, reason: `${target} 에 이미 같은 이름의 항목이 있어 건너뜀` };
  }
  if (!fs.existsSync(skillFinding.skillDirPath)) {
    return { ok: false, reason: `${skillFinding.skillDirPath} 를 찾을 수 없음` };
  }

  try {
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.renameSync(skillFinding.skillDirPath, target);
    return { ok: true, from: skillFinding.skillDirPath, to: target };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Applies disableSkill to every unused/rarely-used finding, mutating each
// finding in place with the outcome and returning the list of moves made
// (for the report's "자동 해결 내역" section and for manual restore).
export function applyFixes(claudeHome, skillFindings) {
  const fixActions = [];
  for (const finding of skillFindings) {
    if (finding.hookProtected) {
      finding.fixed = false;
      finding.fixDetail = 'Claude Code hook이 이 스킬 폴더의 파일을 참조하고 있어 자동 비활성화를 건너뜀 (수동으로 확인 후 처리하세요).';
      continue;
    }

    const result = disableSkill(claudeHome, finding);
    if (result.ok) {
      finding.fixed = true;
      finding.fixDetail = `비활성화함: ${result.from} → ${result.to}`;
      fixActions.push({ skill: finding.skillName, from: result.from, to: result.to });
    } else {
      finding.fixed = false;
      finding.fixDetail = `자동 해결 실패: ${result.reason}`;
    }
  }
  return fixActions;
}
