/**
 * 上游直链请求工具（浏览器特征请求头 + 失败/慢速自动重试 + 首段吞吐探测）
 *
 * 背景：光鸭 CDN（*.guangyacdn.com）对非浏览器客户端（无 UA / 无 Referer）
 * 的并发请求会显著限速 —— 实测浏览器直连 ~40MB/s，而 Worker 默认 UA 中继
 * 仅 1.4~9.6KB/s，且首字节 7~9s。因此对属于该 CDN 的直链统一附加
 * Chrome 浏览器特征头，复刻浏览器请求上下文。
 *
 * 自愈策略（默认与诊断分离）：
 *   1. 默认路径（正常播放 / 正常读取）：拿到响应即透传原始流，不做任何阻塞式探测，
 *      首字节延迟等于上游 TTFB（毫秒级）；仅在 4xx/5xx（含签名过期）时重试一次。
 *   2. 诊断路径（请求显式带 probe=1 / debug=1 时才启用，opts.probeFirst=true）：
 *      额外读取前 64KB 做吞吐探测，超过 8s 判定被限速 → 取消连接并重试一次。
 *
 * 说明：实测光鸭 CDN 单连接限速约 200KB/s，对 838kbps（≈105KB/s）的视频码率足够，
 * 而 64KB 阻塞探测会给每次 Range 请求平白叠加数十毫秒到数秒 TTFB，故移出正常路径。
 */

/** Chrome 131 / Windows 完整 UA（与真实浏览器抓包一致） */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 光鸭站点 Origin / Referer（CDN 侧按来源校验或按来源做限速分级） */
export const GUANGYA_ORIGIN = 'https://www.guangyapan.com';
export const GUANGYA_REFERER = 'https://www.guangyapan.com/';

/** 需要附加浏览器特征头的直链域名（含子域） */
const GUANGYA_CDN_DOMAINS = ['guangyacdn.com'];

/** 首段吞吐探测字节数 */
export const PROBE_BYTES = 64 * 1024;
/** 首段探测超时（超过即判定吞吐异常） */
export const PROBE_TIMEOUT_MS = 8000;

/** 判断直链是否属于光鸭 CDN（仅此类域名附加浏览器头，避免污染其他驱动） */
export function isGuangYaCdnUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return GUANGYA_CDN_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/**
 * 组装发往直链的请求头：光鸭 CDN 附加浏览器特征头，其他域名原样返回。
 * extra（如 Range）优先级最高，不会被浏览器头覆盖。
 */
export function browserLikeHeaders(
  raw: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  if (!isGuangYaCdnUrl(raw)) return { ...extra };
  return {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: GUANGYA_REFERER,
    Origin: GUANGYA_ORIGIN,
    ...extra,
  };
}

/** 上游请求结果（body 已完成首段探测并可正常读取） */
export interface UpstreamFetchResult {
  status: number;
  ok: boolean;
  headers: Headers;
  /** 已回填探测阶段的字节，可直接交给 Response 消费 */
  body: ReadableStream<Uint8Array> | null;
  /** 实际尝试次数（1 = 未重试） */
  attempts: number;
  /** 是否因首段吞吐超时被判为慢速 */
  slow: boolean;
  /** 首个 64KB（或流结束）耗时；未启用探测时即上游 TTFB，用于日志定位 */
  probeMs: number;
  /** 探测阶段实际读取字节数 */
  probedBytes: number;
}

export interface UpstreamFetchOptions {
  /** 日志标记（如 guangyapan:<fileId> / stream:guangyapan） */
  tag: string;
  method?: string;
  /** 附加请求头（Range 等） */
  headers?: Record<string, string>;
  /** 重试前换取新直链（签名过期场景）；返回 null 表示沿用原地址 */
  refreshUrl?: () => Promise<string | null>;
  /** 最大尝试次数，默认 2（首次 + 重试一次） */
  maxAttempts?: number;
  /**
   * 是否在返回前做首段吞吐探测（默认 false = 直接透传，毫秒级 TTFB）。
   * 仅当请求显式带 probe=1 / debug=1 的诊断场景置为 true。
   */
  probeFirst?: boolean;
  probeBytes?: number;
  probeTimeoutMs?: number;
}

interface ProbeOutcome {
  body: ReadableStream<Uint8Array> | null;
  slow: boolean;
  bytes: number;
}

/**
 * 读取前 N 字节做吞吐探测：超时则取消连接并重建失败信号，
 * 正常则把已读字节回填进新的 ReadableStream，保证下游拿到完整数据。
 */
async function probeThenRebuild(
  res: Response,
  limit: number,
  timeoutMs: number
): Promise<ProbeOutcome> {
  if (!res.body) return { body: null, slow: false, bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let slow = false;
  const deadline = Date.now() + timeoutMs;

  while (total < limit) {
    const remain = deadline - Date.now();
    if (remain <= 0) {
      slow = true;
      break;
    }
    const readPromise = reader.read();
    const outcome = await Promise.race<
      { kind: 'read'; done: boolean; value?: Uint8Array } | { kind: 'timeout' }
    >([
      readPromise.then((r) => ({ kind: 'read' as const, done: r.done, value: r.value })),
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' as const }), remain)
      ),
    ]);

    if (outcome.kind === 'timeout') {
      slow = true;
      // 超时后仍在等待的 read 会在 cancel 后 settle，挂 catch 避免 unhandled rejection
      readPromise.catch(() => undefined);
      break;
    }
    if (outcome.done) break;
    if (outcome.value && outcome.value.byteLength > 0) {
      chunks.push(outcome.value);
      total += outcome.value.byteLength;
    }
  }

  if (slow) {
    await reader.cancel().catch(() => undefined);
    return { body: null, slow: true, bytes: total };
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
  return { body, slow: false, bytes: total };
}

/**
 * 发起上游直链请求（自动附加浏览器特征头）。
 * 默认直接透传原始流（不探测）；仅 4xx/5xx 时重试一次。
 * 当 opts.probeFirst=true（诊断场景）时额外做首段 64KB 探测，慢速同样重试一次。
 */
export async function fetchUpstreamGuarded(
  rawUrl: string,
  opts: UpstreamFetchOptions
): Promise<UpstreamFetchResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const probeFirst = opts.probeFirst === true;
  const probeBytes = opts.probeBytes ?? PROBE_BYTES;
  const probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  let url = rawUrl;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = browserLikeHeaders(url, opts.headers ?? {});
    const started = Date.now();
    let res: Response | null = null;
    try {
      res = await fetch(url, { method: opts.method ?? 'GET', headers });
    } catch (e) {
      lastError = e;
      console.warn(
        `[upstream:${opts.tag}] attempt ${attempt}/${maxAttempts} network error:`,
        e instanceof Error ? e.message : e
      );
    }

    if (res) {
      const isLastAttempt = attempt >= maxAttempts;
      // 仅在诊断场景（probe=1/debug=1）做吞吐探测；最后一次尝试无论如何都直接透传，
      // 保证下游一定有数据可读（否则两次都被限速时会返回空 body + 非 0 Content-Length，比慢更糟）
      const useProbe = probeFirst && !isLastAttempt;
      const probe: ProbeOutcome = useProbe
        ? await probeThenRebuild(res, probeBytes, probeTimeoutMs)
        : { body: res.body, slow: false, bytes: 0 };
      const result: UpstreamFetchResult = {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        body: probe.body,
        attempts: attempt,
        slow: probe.slow,
        probeMs: Date.now() - started,
        probedBytes: probe.bytes,
      };
      const badStatus = res.status >= 400;
      if (!badStatus && !probe.slow) {
        if (isLastAttempt) {
          console.log(
            `[upstream:${opts.tag}] ${res.status} accepted on last attempt (attempt ${attempt}, ttfb ${result.probeMs}ms)`
          );
        } else if (useProbe) {
          console.log(
            `[upstream:${opts.tag}] ${res.status} first ${probe.bytes}B in ${result.probeMs}ms (attempt ${attempt})`
          );
        } else {
          console.log(
            `[upstream:${opts.tag}] ${res.status} passthrough (attempt ${attempt}, ttfb ${result.probeMs}ms)`
          );
        }
        return result;
      }
      if (isLastAttempt) {
        console.warn(
          `[upstream:${opts.tag}] give up after ${attempt} attempt(s): ${
            badStatus ? `status ${res.status}` : `slow first ${probeBytes}B (${result.probeMs}ms)`
          }`
        );
        return result;
      }
      console.warn(
        `[upstream:${opts.tag}] attempt ${attempt}/${maxAttempts} ${
          badStatus ? `status ${res.status}` : `slow first ${probe.bytes}B in ${result.probeMs}ms`
        } → retry once`
      );
      // 释放当前连接再重试，避免同时占用两条 CDN 长连接
      await result.body?.cancel().catch(() => undefined);
      if (opts.refreshUrl && (res.status === 401 || res.status === 403 || res.status === 410)) {
        const fresh = await opts.refreshUrl().catch(() => null);
        if (fresh && fresh !== url) {
          console.log(`[upstream:${opts.tag}] refreshed signed url for retry`);
          url = fresh;
        }
      }
      continue;
    }

    // fetch 抛错（网络层失败）：还有次数就换地址重试，否则抛出
    if (attempt >= maxAttempts) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`upstream fetch failed after ${attempt} attempt(s)`);
    }
    if (opts.refreshUrl) {
      const fresh = await opts.refreshUrl().catch(() => null);
      if (fresh && fresh !== url) url = fresh;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('upstream fetch failed');
}
