/**
 * 路径工具
 *
 * WebDAV 路径内部约定：
 *   - 根路径为 "/"
 *   - 非根路径以 "/" 开头
 *   - 目录路径以 "/" 结尾（用于区分文件/目录）
 *   - 禁止 ".." 与 "." 片段
 */

/** 规范化原始 URL 路径 → 内部规范路径 */
export function normalizePath(raw: string): string {
  let p = decodeURIComponentSafe(raw);
  if (!p.startsWith('/')) p = '/' + p;

  const segments: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') continue; // 安全策略：忽略越权段
    segments.push(seg);
  }
  return '/' + segments.join('/');
}

/** 路径是否指向目录（以 / 结尾） */
export function isDirPath(path: string): boolean {
  return path.endsWith('/');
}

/** 路径是否指向文件（非根且不以 / 结尾） */
export function isFilePath(path: string): boolean {
  return path !== '/' && !path.endsWith('/');
}

/** 路径作为对象键（S3/R2 使用），目录自动补 "/" */
export function toKey(path: string): string {
  if (path === '/') return '';
  return path.startsWith('/') ? path.slice(1) : path;
}

/** 由对象键反推 WebDAV 路径 */
export function fromKey(key: string): string {
  if (!key) return '/';
  return '/' + key;
}

/** 规范化输出路径：确保以 / 开头且不以 / 结尾（非根） */
export function trimSlashes(path: string): string {
  let p = path;
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** 父路径：/a/b/c → /a/b/（根返回 /） */
export function parentPath(path: string): string {
  const trimmed = trimSlashes(path);
  if (trimmed === '/') return '/';
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx) + '/';
}

/** 路径的显示名：/a/b/c.txt → c.txt；根 → / */
export function baseName(path: string): string {
  const trimmed = trimSlashes(path);
  if (trimmed === '/') return '/';
  const idx = trimmed.lastIndexOf('/');
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** path 是否位于 dir 之下（含自身） */
export function isUnder(path: string, dir: string): boolean {
  if (dir === '/') return true;
  const d = trimSlashes(dir);
  return path === d || path.startsWith(d + '/');
}

/** 拼接子路径 */
export function joinPath(parent: string, name: string): string {
  const p = trimSlashes(parent);
  if (p === '/') return '/' + name;
  return p + '/' + name;
}

/** 目录路径下的相对路径（列表返回名称用） */
export function childName(path: string, parent: string): string {
  const t = trimSlashes(path);
  const p = trimSlashes(parent);
  if (p === '/') return t.slice(1);
  return t.slice(p.length + 1);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
