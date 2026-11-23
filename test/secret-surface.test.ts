import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return [path];
  });
}

describe('secret surface', () => {
  it('does not put a reply credential or callback URL in server source or the routine text', () => {
    const paths = [...filesUnder('src'), 'README.md'];
    const combined = paths.map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(combined).not.toContain('YOUR_REPLY_SECRET');
    expect(combined).not.toContain('reply_url');

    const start = combined.indexOf('ROUTINE PROMPT START');
    const end = combined.indexOf('ROUTINE PROMPT END');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const routine = combined.slice(start, end);
    expect(routine).toContain('submit_reply');
    expect(routine).not.toMatch(/https?:\/\//);
    expect(routine).not.toMatch(/Bearer\s+\S+/);
    expect(routine).not.toContain('REPLY_SECRET');
  });
});