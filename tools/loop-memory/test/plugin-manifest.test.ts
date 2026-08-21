import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = join(__dirname, '..');

// 회귀: plugin.json이 "hooks": "./hooks/hooks.json"을 명시하면 Claude Code가 관례 자동로드본과
// 중복 로드해 "Duplicate hooks file detected" 에러를 낸다(loop-engine 0.4.0에서 실측 — defaultEnabled:
// false라 이 플러그인은 그동안 안 걸렸을 뿐 같은 결함을 그대로 갖고 있었다). hooks/hooks.json은
// 선언 없이도 관례로 자동 로드되므로 manifest.hooks는 아예 없어야 한다.
describe('plugin.json manifest shape', () => {
  it('hooks 필드를 선언하지 않는다(hooks/hooks.json은 관례로 자동 로드됨)', () => {
    const plugin = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8'),
    );
    expect(plugin).not.toHaveProperty('hooks');
  });
});
