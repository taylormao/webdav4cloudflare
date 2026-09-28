/**
 * Telegram Bot 存储驱动
 *
 * 原理：
 *   - 文件内容通过 Bot API sendDocument 上传至 Telegram，得到 file_id
 *   - file_id 与元数据（size / mtime / contentType）存入 KV 索引
 *   - 下载走 getFile 接口获取临时 file_path 后从 CDN 拉取
 *   - 目录为虚拟节点：KV 记录目录 marker（key 以 "/" 结尾）
 *
 * 建议：使用私有频道/群组作为存储空间，chatId 传频道 ID。
 * 限制：Workers 请求体上限 100MB，Telegram 上传需整文件缓冲，建议单文件 ≤ 50MB。
 */
import type { TelegramConfig } from '../config';
import type { FileStat, ListResult, Range, StorageDriver, WriteOptions } from './types';
import { parentPath, baseName } from '../utils/path';

interface IndexRecord {
  fileId?: string;
  size: number;
  mtime: number;
  contentType?: string;
  isDir: boolean;
}

const PREFIX = 'idx:';
/** getUpdates offset 持久化 key（独立于文件索引，避免被 list 当作文件项） */
const OFFSET_KEY = 'updates_offset';

/** Telegram 入站消息结构（仅提取本驱动关心的字段） */
interface TelegramMessage {
  message_id?: number;
  date?: number;
  document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: Array<{ file_id?: string; file_size?: number }>;
  video?: { file_id?: string; mime_type?: string; file_size?: number };
  audio?: { file_id?: string; mime_type?: string; file_size?: number; performer?: string; title?: string };
  voice?: { file_id?: string; mime_type?: string; file_size?: number };
  video_note?: { file_id?: string; mime_type?: string; file_size?: number };
}

/** MIME → 扩展名映射（用于无 file_name 的文件消息生成文件名） */
const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/x-msdownload': 'exe',
  'application/octet-stream': 'bin',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/opus': 'opus',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
};

function extFromMime(mime?: string, fallback = 'bin'): string {
  if (!mime) return fallback;
  const clean = mime.split(';')[0].trim().toLowerCase();
  return MIME_EXT[clean] ?? fallback;
}

/** 清洗文件名，去除路径分隔符与非法字符 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || `file_${Date.now()}`;
}

export class TelegramDriver implements StorageDriver {
  readonly type = 'telegram';
  private apiBase: string;

  constructor(private cfg: TelegramConfig, private kv: KVNamespace | undefined) {
    if (!cfg.botToken) throw new Error('TELEGRAM_BOT_TOKEN is required for telegram driver');
    if (!cfg.chatId) throw new Error('TELEGRAM_CHAT_ID is required for telegram driver');
    if (!kv) throw new Error('TELEGRAM_INDEX KV binding is required for telegram driver');
    this.apiBase = `https://api.telegram.org/bot${cfg.botToken}`;
  }

  private keyOf(path: string): string {
    return PREFIX + path;
  }

  // ---------- list ----------
  async list(path: string): Promise<ListResult> {
    // 入站消息增量同步（幂等；失败不影响列表返回）
    await this.syncUpdates();
    const dirKey = this.keyOf(path);
    // 列出该前缀下的全部索引（KV list 支持 prefix）
    const files: FileStat[] = [];
    const dirNames = new Set<string>();

    let cursor: string | undefined;
    do {
      const res = await this.kv!.list({ prefix: dirKey, cursor });
      for (const k of res.keys) {
        const rec = await this.readRecord(k.name);
        if (!rec) continue;
        const rel = k.name.slice(dirKey.length);
        // 直接子文件：rel 不包含 /
        if (!rel.includes('/')) {
          files.push(this.recordToStat(k.name, rec));
        } else {
          // 直接子目录：rel 的第一段
          const first = rel.split('/')[0];
          if (first) dirNames.add(first);
        }
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);

    const entries: FileStat[] = [
      ...Array.from(dirNames).map((name) => ({
        name,
        path: joinDir(path, name),
        isDirectory: true,
        size: 0,
        mtime: Date.now(),
      })),
      ...files,
    ];
    return { entries, truncated: false };
  }

  // ---------- stat ----------
  async stat(path: string): Promise<FileStat | null> {
    // 入站消息增量同步（根目录 stat 高频但无必要，跳过以减 API 调用）
    if (path !== '/') await this.syncUpdates();
    if (path === '/') {
      return { name: '/', path: '/', isDirectory: true, size: 0, mtime: Date.now() };
    }
    const rec = await this.readRecord(this.keyOf(path));
    if (rec) return this.recordToStat(this.keyOf(path), rec);

    // 目录：检查是否可作为其他项的前缀
    if (!path.endsWith('/')) {
      const asDir = await this.hasChildren(path);
      if (asDir) {
        return {
          name: baseName(path),
          path: path + '/',
          isDirectory: true,
          size: 0,
          mtime: Date.now(),
        };
      }
    } else {
      const has = await this.hasChildren(path);
      if (has) {
        return {
          name: baseName(path),
          path,
          isDirectory: true,
          size: 0,
          mtime: Date.now(),
        };
      }
    }
    return null;
  }

  private async hasChildren(dirPath: string): Promise<boolean> {
    const prefix = this.keyOf(dirPath.endsWith('/') ? dirPath : dirPath + '/');
    const res = await this.kv!.list({ prefix, limit: 1 });
    return res.keys.length > 0;
  }

  // ---------- read ----------
  async read(path: string, range?: Range): Promise<ReadableStream | null> {
    const rec = await this.readRecord(this.keyOf(path));
    if (!rec?.fileId) return null;

    // getFile → file_path
    const res = await fetch(`${this.apiBase}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: rec.fileId }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      result?: { file_path?: string };
    };
    if (!data.ok || !data.result?.file_path) return null;

    const url = `https://api.telegram.org/file/bot${this.cfg.botToken}/${data.result.file_path}`;
    const fileRes = await fetch(url);
    if (!fileRes.ok || !fileRes.body) return null;

    // Telegram 下载端点不支持 Range；有 Range 时先缓冲再截取（文件 ≤50MB 场景可接受）
    if (range) {
      const buf = await fileRes.arrayBuffer();
      const slice = buf.slice(range.offset, range.offset + range.length);
      return new Response(slice).body;
    }
    return fileRes.body;
  }

  // ---------- write ----------
  async write(path: string, body: ReadableStream | ArrayBuffer, opts?: WriteOptions): Promise<void> {
    // 缓冲完整文件
    const buf =
      body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();

    const fd = new FormData();
    fd.append('chat_id', this.cfg.chatId);
    fd.append('document', new Blob([buf], { type: opts?.contentType ?? 'application/octet-stream' }), baseName(path));

    const res = await fetch(`${this.apiBase}/sendDocument`, { method: 'POST', body: fd });
    const data = (await res.json()) as {
      ok: boolean;
      result?: { document?: { file_id?: string } };
    };
    if (!data.ok || !data.result?.document?.file_id) {
      throw new Error(`Telegram upload failed: ${JSON.stringify(data)}`);
    }

    const rec: IndexRecord = {
      fileId: data.result.document.file_id,
      size: buf.byteLength,
      mtime: Date.now(),
      contentType: opts?.contentType,
      isDir: false,
    };
    await this.kv!.put(this.keyOf(path), JSON.stringify(rec));
  }

  // ---------- 入站消息同步（getUpdates 增量拉取） ----------
  private static readonly MAX_INBOUND_SIZE = 20 * 1024 * 1024; // Bot API getFile 下载上限 20MB
  private static readonly SYNC_THROTTLE_MS = 5000;
  private lastSyncAt = 0;

  /**
   * 增量拉取 bot 收到的文件类消息并写入索引。
   * - offset 持久化到 KV（updates_offset），全部处理成功后才推进（失败不丢 offset，幂等重试）
   * - 节流：同一驱动实例 5s 内不重复轮询（增量语义下下次同步仍可拉到新消息）
   * - 任何失败仅记录日志，不影响 list/stat 正常返回
   */
  async syncUpdates(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSyncAt < TelegramDriver.SYNC_THROTTLE_MS) return;
    this.lastSyncAt = now;

    try {
      let offset = 0;
      const raw = await this.kv!.get(OFFSET_KEY);
      if (raw) offset = parseInt(raw, 10) || 0;

      let processed = 0;
      let skipped = 0;
      let nextOffset = offset;

      // timeout=0：立即返回当前积压（不阻塞，适合 Worker 环境）
      while (true) {
        const url = `${this.apiBase}/getUpdates?offset=${nextOffset}&timeout=0`;
        const res = await fetch(url);
        const data = (await res.json()) as {
          ok: boolean;
          result?: Array<{ update_id: number; message?: TelegramMessage }>;
        };
        if (!data.ok) break;
        const updates = data.result ?? [];
        if (!updates.length) break;

        for (const u of updates) {
          if (u.message) {
            const outcome = await this.indexInboundMessage(u.message);
            if (outcome === 'indexed') processed++;
            else if (outcome === 'skipped') skipped++;
          }
          nextOffset = Math.max(nextOffset, u.update_id + 1);
        }
        // Telegram 单次最多返回 100 条；不足 100 说明已拉完
        if (updates.length < 100) break;
      }

      // 全部处理成功才推进 offset；失败抛错时 offset 不写入，下次重试不丢消息
      if (nextOffset > offset) {
        await this.kv!.put(OFFSET_KEY, String(nextOffset));
      }
      if (skipped > 0) {
        console.log(
          `[telegram] syncUpdates: indexed=${processed}, skipped(>${TelegramDriver.MAX_INBOUND_SIZE / 1024 / 1024}MB)=${skipped}`,
        );
      }
    } catch (err) {
      console.error('[telegram] syncUpdates failed:', err);
    }
  }

  /** 处理单条消息：提取文件信息并写入索引；返回 indexed / skipped / ignored */
  private async indexInboundMessage(
    msg: TelegramMessage,
  ): Promise<'indexed' | 'skipped' | 'ignored'> {
    const file = this.extractFileFromMessage(msg);
    if (!file) return 'ignored';

    // 大小过滤：>20MB 跳过（getFile 下载上限）
    if (file.file_size != null && file.file_size > TelegramDriver.MAX_INBOUND_SIZE) {
      return 'skipped';
    }

    const key = await this.uniqueKey(file.fileName, file.fileId);
    if (!key) return 'indexed'; // 已存在且 fileId 相同（幂等重复）

    const rec: IndexRecord = {
      fileId: file.fileId,
      size: file.file_size ?? 0,
      mtime: (msg.date ?? 0) * 1000,
      contentType: file.mime_type,
      isDir: false,
    };
    await this.kv!.put(key, JSON.stringify(rec));
    return 'indexed';
  }

  /**
   * 生成不冲突的索引 key：同名文件加 -1/-2 后缀；已有记录且 fileId 相同视为幂等重复返回 null。
   * 入站文件统一放分区根目录（keyOf 内部路径，如 idx:/视频笔记.zip）。
   */
  private async uniqueKey(fileName: string, fileId: string): Promise<string | null> {
    const safeName = sanitizeFileName(fileName);
    let key = this.keyOf('/' + safeName);
    const existing = await this.readRecord(key);
    if (existing) {
      if (existing.fileId === fileId) return null; // 幂等：同 fileId 已索引
      const dot = safeName.lastIndexOf('.');
      const base = dot > 0 ? safeName.slice(0, dot) : safeName;
      const ext = dot > 0 ? safeName.slice(dot) : '';
      for (let i = 1; i < 100; i++) {
        const alt = `${base}-${i}${ext}`;
        const altKey = this.keyOf('/' + alt);
        if (!(await this.readRecord(altKey))) {
          key = altKey;
          break;
        }
      }
    }
    return key;
  }

  /** 从消息中提取文件信息；无文件类内容返回 null */
  private extractFileFromMessage(msg: TelegramMessage): {
    fileName: string;
    fileId: string;
    file_size?: number;
    mime_type?: string;
  } | null {
    const mid = msg.message_id ?? 0;

    if (msg.document?.file_id) {
      const d = msg.document;
      const name =
        d.file_name && d.file_name.trim()
          ? d.file_name.trim()
          : `doc_${mid}.${extFromMime(d.mime_type)}`;
      return { fileName: name, fileId: d.file_id!, file_size: d.file_size, mime_type: d.mime_type };
    }
    if (msg.photo?.length) {
      const p = msg.photo[msg.photo.length - 1]; // 最大尺寸
      return { fileName: `photo_${mid}.jpg`, fileId: p.file_id!, file_size: p.file_size, mime_type: 'image/jpeg' };
    }
    if (msg.video?.file_id) {
      return { fileName: `video_${mid}.mp4`, fileId: msg.video.file_id, file_size: msg.video.file_size, mime_type: msg.video.mime_type ?? 'video/mp4' };
    }
    if (msg.voice?.file_id) {
      return { fileName: `voice_${mid}.ogg`, fileId: msg.voice.file_id, file_size: msg.voice.file_size, mime_type: msg.voice.mime_type ?? 'audio/ogg' };
    }
    if (msg.audio?.file_id) {
      const a = msg.audio;
      const base =
        a.performer && a.title ? `${a.performer} - ${a.title}` : `audio_${mid}`;
      return { fileName: `${base}.${extFromMime(a.mime_type, 'mp3')}`, fileId: a.file_id!, file_size: a.file_size, mime_type: a.mime_type };
    }
    if (msg.video_note?.file_id) {
      return { fileName: `video_note_${mid}.mp4`, fileId: msg.video_note.file_id, file_size: msg.video_note.file_size, mime_type: msg.video_note.mime_type ?? 'video/mp4' };
    }
    return null;
  }

  // ---------- remove ----------
  async remove(path: string): Promise<void> {
    const stat = await this.stat(path);
    if (!stat) throw new Error('Not found');

    if (stat.isDirectory) {
      // 删除所有子项（含 marker）
      const dirPath = stat.path;
      const prefix = this.keyOf(dirPath.endsWith('/') ? dirPath : dirPath + '/');
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await this.kv!.list({ prefix, cursor });
        keys.push(...res.keys.map((k) => k.name));
        cursor = res.list_complete ? undefined : res.cursor;
      } while (cursor);
      for (const k of keys) await this.kv!.delete(k);
      // 目录 marker 本身
      await this.kv!.delete(this.keyOf(dirPath));
    } else {
      await this.kv!.delete(this.keyOf(path));
    }
  }

  // ---------- mkdir ----------
  async mkdir(path: string): Promise<void> {
    const rec: IndexRecord = { size: 0, mtime: Date.now(), isDir: true };
    await this.kv!.put(this.keyOf(path.endsWith('/') ? path : path + '/'), JSON.stringify(rec));
  }

  // ---------- move / copy ----------
  async move(src: string, dst: string): Promise<void> {
    await this.duplicate(src, dst, true);
  }

  async copy(src: string, dst: string): Promise<void> {
    await this.duplicate(src, dst, false);
  }

  private async duplicate(src: string, dst: string, removeSrc: boolean): Promise<void> {
    const stat = await this.stat(src);
    if (!stat) throw new Error('Source not found');

    if (!stat.isDirectory) {
      const rec = await this.readRecord(this.keyOf(src));
      if (!rec) throw new Error('Source index missing');
      await this.kv!.put(this.keyOf(dst), JSON.stringify(rec));
      if (removeSrc) await this.kv!.delete(this.keyOf(src));
      return;
    }

    // 目录递归：遍历所有后代索引
    const srcDir = stat.path.endsWith('/') ? stat.path : stat.path + '/';
    const prefix = this.keyOf(srcDir);
    const entries: Array<{ key: string; rec: IndexRecord }> = [];
    let cursor: string | undefined;
    do {
      const res = await this.kv!.list({ prefix, cursor });
      for (const k of res.keys) {
        const rec = await this.readRecord(k.name);
        if (rec) entries.push({ key: k.name, rec });
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);

    const dstDir = dst.endsWith('/') ? dst : dst + '/';
    for (const e of entries) {
      const rel = e.key.slice(prefix.length);
      const newKey = this.keyOf(dstDir + rel);
      await this.kv!.put(newKey, JSON.stringify(e.rec));
    }
    // 目录 marker
    await this.kv!.put(this.keyOf(dstDir), JSON.stringify({ size: 0, mtime: Date.now(), isDir: true }));

    if (removeSrc) {
      for (const e of entries) await this.kv!.delete(e.key);
      await this.kv!.delete(this.keyOf(srcDir));
    }
  }

  // ---------- helpers ----------
  private async readRecord(key: string): Promise<IndexRecord | null> {
    const raw = await this.kv!.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as IndexRecord;
    } catch {
      return null;
    }
  }

  private recordToStat(key: string, rec: IndexRecord): FileStat {
    const relPath = key.slice(PREFIX.length);
    return {
      name: baseName(relPath),
      path: relPath,
      isDirectory: rec.isDir,
      size: rec.size,
      mtime: rec.mtime,
      contentType: rec.contentType,
    };
  }
}

function joinDir(parent: string, name: string): string {
  if (parent === '/') return '/' + name + '/';
  return (parent.endsWith('/') ? parent : parent + '/') + name + '/';
}
