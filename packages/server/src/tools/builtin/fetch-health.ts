/**
 * 抓取网络状态（每个 agent loop 一份，挂在 ToolContext.runState 上）。
 *
 * 实测：网络层失败不是均匀发生的——69% 集中在几个小时里（代理抖动 / 断网时段），
 * 而且是"时好时坏"（最严重的时段里仍有约两成抓取能成功）。所以对付它的顺序是：
 *  1. 先救：瞬时性的连接错误在工具内直接重试。一次抓取失败 = 一整步模型往返（实测中位
 *     7.5 万 token 的上下文重读），工具内救回一次就省一步；
 *  2. 说清：失败原因带上底层错误码；网络明显不稳时把状态告诉模型（"最近 12 次有 10 次
 *     失败"），让它自己决定换源 / 靠搜索摘要 / 带说明作答——不替它做决定；
 *  3. 最后才停：连续多次、对不同站点都失败 → 判定"网络不可用"。此时也不立刻终止任务：
 *     冷却期后放行一次探测（网络恢复就自动续上），模型仍坚持抓取才由主循环强制收尾（可续跑）。
 *
 * 阈值来自真实数据的回放：按"连续失败 + 涉及不同站点数"模拟，连续 10 次且 ≥3 个站点
 * 只在成功率已经跌到一成以下的任务里触发；用"窗口失败率"做熔断则会误伤时好时坏的任务。
 */

export type FetchOutcome = { host: string; ok: boolean; network: boolean };

export const FETCH_HEALTH = {
  /** "网络不稳"看最近多少次抓取 */
  WINDOW: 12,
  /** 窗口内网络层失败达到这个数 → 网络不稳（提示模型） */
  DEGRADED_FAILS: 9,
  /** 连续网络层失败达到这个数、且涉及 ≥ DEAD_HOSTS 个不同站点 → 网络不可用 */
  DEAD_STREAK: 10,
  DEAD_HOSTS: 3,
  /** 判定不可用后的冷却：冷却期满放行一次探测 */
  PROBE_AFTER_MS: 60_000,
  /** 工具内重试（不含首次）与退避：只对"连接被中断"这类瞬时错误、只对幂等的 GET/HEAD */
  RETRIES: 2,
  BACKOFF_MS: [800, 3000] as readonly number[],
} as const;

export class FetchHealth {
  private recent: FetchOutcome[] = [];
  private streak = 0;
  private streakHosts = new Set<string>();
  private deadStreak = 0;
  private deadHosts = 0;
  private probeAfter = 0;
  /** 判定"网络不可用"之后，模型仍然发起的抓取次数（含快速失败与失败的探测）— 主循环据此决定何时强制收尾 */
  private attemptsAfterDead = 0;

  get dead(): boolean {
    return this.probeAfter > 0;
  }

  get attemptsWhileDead(): number {
    return this.attemptsAfterDead;
  }

  /** 网络不可用期间没有发请求的直接失败（调用方已经拿到 NETWORK_DOWN） */
  markFastFail(): void {
    if (this.dead) this.attemptsAfterDead++;
  }

  /**
   * 这次抓取是否应该发请求。网络不可用且未到探测时间 → false（调用方直接快速失败，
   * 不白等三次重试）。
   */
  shouldAttempt(now = Date.now()): boolean {
    return !this.dead || now >= this.probeAfter;
  }

  record(outcome: FetchOutcome, now = Date.now()): void {
    this.recent.push(outcome);
    if (this.recent.length > FETCH_HEALTH.WINDOW) this.recent.shift();

    if (!outcome.ok && outcome.network) {
      this.streak++;
      this.streakHosts.add(outcome.host);
      if (this.dead) {
        // 探测仍然失败：顺延下一次探测
        this.probeAfter = now + FETCH_HEALTH.PROBE_AFTER_MS;
        this.attemptsAfterDead++;
      } else if (this.streak >= FETCH_HEALTH.DEAD_STREAK && this.streakHosts.size >= FETCH_HEALTH.DEAD_HOSTS) {
        this.deadStreak = this.streak;
        this.deadHosts = this.streakHosts.size;
        this.probeAfter = now + FETCH_HEALTH.PROBE_AFTER_MS;
      }
      return;
    }
    // 收到了服务器响应（哪怕 403 / 404）就说明网络是通的
    this.streak = 0;
    this.streakHosts.clear();
    this.probeAfter = 0;
    this.attemptsAfterDead = 0;
  }

  /** 给模型的网络状态提示；null = 状态正常，不打扰 */
  note(): string | null {
    if (this.dead) {
      const waitSec = Math.max(1, Math.ceil((this.probeAfter - Date.now()) / 1000));
      return `网络不可用：已连续 ${this.deadStreak} 次抓取在网络层失败（涉及 ${this.deadHosts} 个不同站点，每次都已内部重试），` +
        `${waitSec} 秒后才会再探测一次。请不要再抓取——基于已核实的内容作答，并说明哪些内容因网络问题未能核实。`;
    }
    const fails = this.recent.filter(x => !x.ok && x.network).length;
    if (fails >= FETCH_HEALTH.DEGRADED_FAILS) {
      const hosts = new Set(this.recent.filter(x => !x.ok && x.network).map(x => x.host)).size;
      return `网络不稳定：最近 ${this.recent.length} 次抓取有 ${fails} 次在网络层失败（涉及 ${hosts} 个站点）。` +
        `继续抓取每失败一次都会消耗一步——优先用手头已有资料或搜索摘要，必要时基于已核实内容作答并加以说明。`;
    }
    return null;
  }

  /** 摘要（事件 / 调试用）：*AtDead 是判定"网络不可用"那一刻的连续失败数与站点数 */
  snapshot(): { streak: number; hosts: number; dead: boolean; recentFails: number; streakAtDead: number; hostsAtDead: number } {
    return {
      streak: this.streak,
      hosts: this.streakHosts.size,
      dead: this.dead,
      recentFails: this.recent.filter(x => !x.ok && x.network).length,
      streakAtDead: this.deadStreak,
      hostsAtDead: this.deadHosts,
    };
  }
}

/** runState 里的键：主循环与 http_fetch 共享同一个实例 */
export const FETCH_HEALTH_KEY = 'fetchHealth';

/**
 * 底层错误分类：决定要不要重试、错误信息怎么写、算不算网络层失败。
 * Node 原生 fetch 的网络错误是 TypeError("fetch failed")，真正原因在 err.cause.code。
 */
export type NetworkErrorKind = 'cancelled' | 'timeout' | 'dns' | 'tls' | 'refused' | 'reset' | 'unknown';

export function classifyNetworkError(err: any, signal?: AbortSignal): { kind: NetworkErrorKind; code: string; transient: boolean; network: boolean } {
  if (signal?.aborted || err?.name === 'AbortError') return { kind: 'cancelled', code: '', transient: false, network: false };
  if (err?.name === 'TimeoutError') return { kind: 'timeout', code: 'TIMEOUT', transient: false, network: true };
  const code = String(err?.cause?.code ?? err?.code ?? '');
  const text = `${err?.cause?.message ?? ''} ${err?.message ?? ''}`;
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_FAIL)$/.test(code) || /getaddrinfo/i.test(text)) {
    return { kind: 'dns', code: code || 'DNS', transient: false, network: true };
  }
  if (/^(CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|ERR_SSL_)/.test(code)) {
    return { kind: 'tls', code, transient: false, network: true };
  }
  if (/^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EACCES|EPERM|EPROTONOSUPPORT|UND_ERR_PROXY|PROXY)/.test(code)) {
    return { kind: 'refused', code, transient: false, network: true };
  }
  if (/^(ECONNRESET|EPIPE|ECONNABORTED|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_SOCKET|UND_ERR_ABORTED|UND_ERR_REQ_RETRY|UND_ERR_REQ_RETRYING|HPE_)/.test(code)) {
    return { kind: 'reset', code, transient: true, network: true };
  }
  if (/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/.test(code)) {
    return { kind: 'timeout', code, transient: false, network: true };
  }
  // 只有 "fetch failed" 没有具体码：按瞬时处理（多半是连接被对端关闭），让它有机会重试一次
  if (/fetch failed|other side closed|socket hang up/i.test(text) || err instanceof TypeError) {
    return { kind: 'reset', code: code || 'FETCH_FAILED', transient: true, network: true };
  }
  return { kind: 'unknown', code, transient: false, network: false };
}

/** 错误信息：原因 + 底层错误码（模型据此判断该重试、换源还是放弃） */
export function describeNetworkError(kind: NetworkErrorKind, code: string, host: string, proxyConfigured: boolean): string {
  switch (kind) {
    case 'dns':
      return `域名无法解析（${code}）: ${host} — 该站点当前解析不到，换一个来源，不要重试同一地址`;
    case 'tls':
      return `安全连接失败（${code}）: ${host} — 证书或协议握手不通过，换一个来源（如存档副本），不要重试同一地址`;
    case 'refused':
      return `连接被拒绝（${code}）: ${host}${proxyConfigured ? '（已配置代理 — 可能是代理没有启动或不可用）' : ''} — 换一个来源或稍后再试`;
    case 'reset':
      return `连接被中断（${code || '连接被对端关闭'}）: ${host} — 属于瞬时性网络错误${proxyConfigured ? '（已配置代理，可能是代理不稳定）' : ''}`;
    case 'timeout':
      return `请求超时（${code || 'TIMEOUT'}）: ${host} — 目标响应太慢或网络不通`;
    default:
      return `请求失败（${code || '未知网络错误'}）: ${host}`;
  }
}
