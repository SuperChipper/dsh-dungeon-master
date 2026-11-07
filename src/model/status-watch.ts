/**
 * 上游健康监测与主备切换。
 *
 * 两条链路互为主备：opencode-go（有公开状态接口）与 commandcode（没有，只能自己探）。
 * 任何一侧降级就切到另一侧，而不是退回官方源——官方源是兜底，不是日常对等选项。
 *
 * 两种探测方式：
 * - `status`：读 opencode 的公开状态页，免费、按模型细分，但有 5 分钟粒度。
 * - `request`：发一个 max_tokens=8 的流式请求，量首 token 时延。要花 token，
 *   但能测到"真的应答"这一层——网关挂了和模型挂了在这里是同一个信号。
 */

export type HealthState = 'operational' | 'degraded' | 'outage' | 'unknown';

export interface Health {
  state: HealthState;
  /** 原始原因，如 upstream / latency / ttft / network */
  reason: string;
  /** 首 token 时延（毫秒），只有 request 探测有 */
  ttftMs?: number;
  detail: string;
}

export interface ProbeSpec {
  provider: string;
  model: string;
  /** 请求探测用的凭据环境变量名；状态接口方式不需要 */
  apiKeyEnv?: string;
  /** 探测方式；不写就按 provider 推断 */
  kind?: 'status' | 'request';
  /** 请求探测的聊天端点；不写按 provider 推断 */
  endpoint?: string;
}

const STATUS_URL = 'https://opencode.ai/status/api/status';
const STATUS_SERVICE = 'go';
const STATUS_PROVIDERS = new Set(['opencode-go', 'opencode']);
const REQUEST_PROVIDERS: Record<string, string> = {
  commandcode: 'https://api.commandcode.ai/provider/v1/chat/completions',
};

/** 这个 provider 归哪个监测管 */
export function isWatchedProvider(provider: string): boolean {
  return STATUS_PROVIDERS.has(provider) || REQUEST_PROVIDERS[provider] !== undefined;
}

export function probeKindOf(spec: ProbeSpec): 'status' | 'request' {
  if (spec.kind !== undefined) return spec.kind;
  return STATUS_PROVIDERS.has(spec.provider) ? 'status' : 'request';
}

interface StatusPayload {
  status?: string;
  components?: Array<{
    service?: string;
    breakdown?: Array<{
      id?: string;
      status?: string;
      reason?: string;
      speed?: { ttft?: number; tps?: number };
    }>;
  }>;
}

function asState(value: string | undefined): HealthState {
  return value === 'operational' || value === 'degraded' || value === 'outage' ? value : 'unknown';
}

/** 读 opencode 状态页；只看目标模型那一条，不被同服务其他模型或其它服务带偏 */
export async function probeStatus(spec: ProbeSpec, timeoutMs = 10_000): Promise<Health> {
  let payload: StatusPayload;
  try {
    const response = await fetch(STATUS_URL, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-qqbot/health' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { state: 'unknown', reason: 'http', detail: `状态接口 HTTP ${response.status}` };
    }
    payload = (await response.json()) as StatusPayload;
  } catch (err) {
    return { state: 'unknown', reason: 'network', detail: `状态接口不可达：${err instanceof Error ? err.message : String(err)}` };
  }

  const component = payload.components?.find((item) => item.service === STATUS_SERVICE);
  if (component === undefined) {
    return { state: 'unknown', reason: 'missing-service', detail: `状态里没有 ${STATUS_SERVICE} 服务` };
  }
  const entry = component.breakdown?.find((item) => item.id === spec.model);
  if (entry === undefined) {
    // 模型没出现在明细里：可能换了套餐，也可能这个服务不提供它。别据此切源。
    return { state: 'unknown', reason: 'missing-model', detail: `${STATUS_SERVICE} 明细里没有 ${spec.model}` };
  }

  const state = asState(entry.status);
  const reason = entry.reason ?? 'none';
  const ttft = entry.speed?.ttft;
  const tps = entry.speed?.tps;
  const speed = ttft === undefined && tps === undefined ? '' : `（ttft ${ttft ?? '?'}ms，${tps ?? '?'} tps）`;
  return {
    state,
    reason,
    ...(ttft === undefined ? {} : { ttftMs: ttft }),
    detail: state === 'operational' ? `${spec.model} 正常${speed}` : `${spec.model} ${state}（${reason}）${speed}`,
  };
}

/**
 * 发一个极小的流式请求，量到首个内容增量的时延。
 *
 * `max_tokens` 压到 8：探测目的是"这条链路通不通、快不快"，不是回答问题。
 * 超过阈值判 degraded，而不是 outage——慢和断是两件事，快速失败才叫断。
 */
export async function probeRequest(
  spec: ProbeSpec,
  options: { apiKeyEnv?: string; endpoint?: string; thresholdMs?: number; timeoutMs?: number } = {},
): Promise<Health> {
  const endpoint = options.endpoint ?? REQUEST_PROVIDERS[spec.provider];
  if (endpoint === undefined) {
    return { state: 'unknown', reason: 'no-endpoint', detail: `${spec.provider} 没有配置聊天端点` };
  }
  const keyEnv = options.apiKeyEnv ?? spec.apiKeyEnv;
  const key = keyEnv === undefined ? '' : (process.env[keyEnv] ?? '').trim();
  if (key === '') {
    return { state: 'unknown', reason: 'missing-key', detail: `缺少 ${keyEnv ?? 'API key'}，无法探测` };
  }

  const threshold = options.thresholdMs ?? 8_000;
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: spec.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        stream: true,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (err) {
    const elapsed = Math.round(performance.now() - started);
    // 网络失败判 degraded 而不是 outage：实测过一次 fetch failed，紧接着同一条请求就 200，
    // 多半是代理瞬时抖动。真正的「断」应当靠连续次数确认，不该一次就下结论。
    return { state: 'degraded', reason: 'network', ttftMs: elapsed, detail: `${spec.model} 连接失败（${elapsed}ms）：${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const elapsed = Math.round(performance.now() - started);
    // 403 MODEL_NOT_IN_PLAN 不是故障，是套餐不包含：判 unknown，别在两侧之间白切
    if (/MODEL_NOT_IN_PLAN/.test(body)) {
      return { state: 'unknown', reason: 'not-in-plan', ttftMs: elapsed, detail: `${spec.model} 不在当前套餐里` };
    }
    const outage = response.status >= 500 || response.status === 429;
    return {
      state: outage ? 'outage' : 'unknown',
      reason: `http-${response.status}`,
      ttftMs: elapsed,
      detail: `${spec.model} HTTP ${response.status}`,
    };
  }

  let firstDelta: number | undefined;
  try {
    const body = response.body;
    if (body !== null) {
      const decoder = new TextDecoder();
      let seen = '';
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        seen += decoder.decode(chunk, { stream: true });
        if (seen.includes('"delta"') || seen.includes('"content"')) {
          firstDelta = performance.now() - started;
          break;
        }
      }
    }
  } catch {
    /* 读流失败按下面统一处理 */
  }

  const elapsed = Math.round(firstDelta ?? performance.now() - started);
  if (firstDelta === undefined) {
    return { state: 'degraded', reason: 'no-output', ttftMs: elapsed, detail: `${spec.model} 连上了但 ${elapsed}ms 内没有任何输出` };
  }
  if (elapsed > threshold) {
    return { state: 'degraded', reason: 'ttft', ttftMs: elapsed, detail: `${spec.model} 首 token ${elapsed}ms，超过阈值 ${threshold}ms` };
  }
  return { state: 'operational', reason: 'ok', ttftMs: elapsed, detail: `${spec.model} 正常（首 token ${elapsed}ms）` };
}

export async function probe(
  spec: ProbeSpec,
  options: { apiKeyEnv?: string; endpoint?: string; thresholdMs?: number; timeoutMs?: number } = {},
): Promise<Health> {
  return probeKindOf(spec) === 'status' ? probeStatus(spec, options.timeoutMs) : probeRequest(spec, options);
}

export interface ModelWatchOptions {
  /** 主用（默认 opencode 那条） */
  primary: ProbeSpec;
  /** 备用（默认 commandcode 那条） */
  backup: ProbeSpec;
  /** 轮询间隔，默认 5 分钟 */
  intervalMs?: number;
  /** 连续几次异常才切走，默认 1 */
  failThreshold?: number;
  /** 连续几次正常才切回主用，默认 3 */
  recoverThreshold?: number;
  /** 请求探测的时延阈值（毫秒），默认 8000 */
  ttftThresholdMs?: number;
  /** 执行切换 */
  switchTo: (target: { provider: string; model: string }, health: Health) => Promise<void>;
  switchBack: (target: { provider: string; model: string }, health: Health) => Promise<void>;
  log: (message: string) => void;
  /** 测试注入：替换真实探测，避免用例依赖网络与额度 */
  __probe?: (spec: ProbeSpec, options: { thresholdMs?: number }) => Promise<Health>;
}

/** unknown 既不算好也不算坏：不动。避免"接口没回话"被当成"服务挂了" */
function isHealthy(state: HealthState): boolean {
  return state === 'operational';
}

function isSick(state: HealthState): boolean {
  return state === 'degraded' || state === 'outage';
}

/**
 * 两侧互备的状态机。
 *
 * 每轮同时探两边：只探当前在用的那侧，切过去以后就没有依据判断"什么时候该回来"。
 * 代价是每轮两次探测，换来的是切换方向的判断始终有数据支撑。
 */
export class ModelWatch {
  private timer: NodeJS.Timeout | undefined;
  private usingBackup = false;
  private primaryHealth: Health = { state: 'unknown', reason: 'init', detail: '尚未探测' };
  private backupHealth: Health = { state: 'unknown', reason: 'init', detail: '尚未探测' };
  private badPrimary = 0;
  private goodPrimary = 0;
  private badBackup = 0;

  public constructor(private readonly options: ModelWatchOptions) {}

  public get state(): {
    usingBackup: boolean;
    primary: Health;
    backup: Health;
  } {
    return { usingBackup: this.usingBackup, primary: this.primaryHealth, backup: this.backupHealth };
  }

  public start(): void {
    if (this.timer !== undefined) return;
    const interval = this.options.intervalMs ?? 5 * 60_000;
    this.timer = setInterval(() => { void this.tick(); }, interval);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    const p = this.options.primary;
    const b = this.options.backup;
    this.options.log(
      `model-watch: 已启动，每 ${Math.round(interval / 60_000)} 分钟对 ${p.provider}/${p.model} 与 ${b.provider}/${b.model} 各探一次`,
    );
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async tick(): Promise<void> {
    const probeOptions = {
      thresholdMs: this.options.ttftThresholdMs ?? 8_000,
    };
    // 测试可注入 __probe：真打网络会让用例不稳定，也不该消耗额度
    const run = this.options.__probe ?? probe;
    const [primary, backup] = await Promise.all([
      run(this.options.primary, probeOptions),
      run(this.options.backup, probeOptions),
    ]);
    this.primaryHealth = primary;
    this.backupHealth = backup;

    const failThreshold = this.options.failThreshold ?? 1;
    const recoverThreshold = this.options.recoverThreshold ?? 3;

    if (!this.usingBackup) {
      if (!isSick(primary.state)) {
        this.badPrimary = 0;
        return;
      }
      this.badPrimary += 1;
      if (this.badPrimary < failThreshold) return;
      if (!isHealthy(backup.state)) {
        this.options.log(`model-watch: 主用异常（${primary.detail}），但备用未验证（${backup.state}），暂不切换`);
        return;
      }
      this.badPrimary = 0;
      this.usingBackup = true;
      this.goodPrimary = 0;
      this.options.log(`model-watch: 主用异常（${primary.detail}）→ 切到备用 ${backup.detail}`);
      await this.options.switchTo({ provider: this.options.backup.provider, model: this.options.backup.model }, backup);
      return;
    }

    // 备用态
    if (isSick(backup.state)) {
      this.badBackup += 1;
      // 备用自己坏了：主用只要还正常就立刻回去，别在两个坏路口之间犹豫
      if (this.badBackup >= failThreshold && isHealthy(primary.state)) {
        this.badBackup = 0;
        this.usingBackup = false;
        this.goodPrimary = 0;
        this.options.log(`model-watch: 备用异常（${backup.detail}）→ 回主用 ${primary.detail}`);
        await this.options.switchBack({ provider: this.options.primary.provider, model: this.options.primary.model }, primary);
      }
      return;
    }
    this.badBackup = 0;

    if (isHealthy(primary.state)) {
      this.goodPrimary += 1;
      if (this.goodPrimary < recoverThreshold) return;
      this.goodPrimary = 0;
      this.usingBackup = false;
      this.options.log(`model-watch: 主用已恢复（${primary.detail}）→ 切回`);
      await this.options.switchBack({ provider: this.options.primary.provider, model: this.options.primary.model }, primary);
      return;
    }
    this.goodPrimary = 0;
  }
}
