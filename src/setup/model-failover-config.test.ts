/**
 * modelFailover 配置项的服务端校验测试。
 *
 * 这里只测 Schema 本身的行为（三处同步里的第 1、2 步）：设置页保存时
 * `EDITABLE_CONFIG_SCHEMAS` 若忘了挂这个键，POST 会直接 400「不支持的字段」。
 * 所以真正要守住的是"这个键能被接受、越界值会被拒"。
 */
import { describe, expect, it } from 'vitest';
import { ModelFailoverSchema } from '../config.ts';

const valid = {
  enabled: true,
  intervalMinutes: 10,
  failThreshold: 1,
  recoverThreshold: 3,
  primaryProvider: 'opencode-go',
  primaryModel: 'deepseek-v4.1-flash',
  backupProvider: 'commandcode',
  backupModel: 'deepseek/deepseek-v4.1-flash',
  primaryApiKeyEnv: '',
  backupApiKeyEnv: 'COMMANDCODE_API_KEY',
  ttftThresholdMs: 8000,
  notify: true,
};

describe('ModelFailoverSchema', () => {
  it('接受一份合法配置', () => {
    const parsed = ModelFailoverSchema(valid) as typeof valid;
    expect(parsed.enabled).toBe(true);
    expect(parsed.intervalMinutes).toBe(10);
    expect(parsed.backupProvider).toBe('commandcode');
    expect(parsed.backupModel).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('空对象补默认值', () => {
    const parsed = ModelFailoverSchema({}) as typeof valid;
    expect(parsed.enabled).toBe(false);
    expect(parsed.intervalMinutes).toBe(10);
    expect(parsed.failThreshold).toBe(1);
    expect(parsed.recoverThreshold).toBe(3);
    expect(parsed.backupProvider).toBe('commandcode');
    expect(parsed.backupModel).toBe('deepseek/deepseek-v4.1-flash');
    expect(parsed.notify).toBe(true);
  });

  it('类型错误被拒', () => {
    expect(() => ModelFailoverSchema({ enabled: 'yes' })).toThrow();
    expect(() => ModelFailoverSchema({ intervalMinutes: 'five' })).toThrow();
    expect(() => ModelFailoverSchema({ failThreshold: {} })).toThrow();
  });

  it('保留字符串字段原值（不擅自 trim/改写）', () => {
    const parsed = ModelFailoverSchema({ ...valid, primaryModel: '  padded  ' }) as typeof valid;
    expect(parsed.primaryModel).toBe('  padded  ');
  });
});
