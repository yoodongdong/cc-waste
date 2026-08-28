import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveClaudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Claude Code writes one JSONL transcript per session under
// <claudeHome>/projects/<project-slug>/<session-id>.jsonl
export function findSessionFiles(claudeHome) {
  const projectsDir = path.join(claudeHome, 'projects');
  const results = [];
  if (!fs.existsSync(projectsDir)) return results;

  for (const projectSlug of fs.readdirSync(projectsDir)) {
    const projectDir = path.join(projectsDir, projectSlug);
    let stat;
    try {
      stat = fs.statSync(projectDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    for (const entry of fs.readdirSync(projectDir)) {
      if (entry.endsWith('.jsonl')) {
        results.push({ projectSlug, filePath: path.join(projectDir, entry) });
      }
    }
  }
  return results;
}
