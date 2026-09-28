/**
 * 轻量 XML 工具
 *
 * 由于 Workers 无内置 XML 解析器，PROPFIND / PROPPATCH 请求体结构简单，
 * 使用轻量正则解析；响应 XML 用手写生成函数构造。
 */

/** 解析请求体中 <prop>...</prop> 内的属性名（仅返回标签名列表） */
export function parsePropFindProps(xml: string): string[] {
  const props: string[] = [];
  const m = xml.match(/<prop\b[^>]*>([\s\S]*?)<\/prop>/i);
  if (!m) return props;
  const inner = m[1];
  // 匹配所有自闭合或成对标签，忽略命名空间前缀
  const re = /<([A-Za-z0-9_]+:)?([A-Za-z0-9_-]+)(?:\s[^>]*)?\/?>/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(inner)) !== null) {
    const name = mm[2];
    if (name !== 'prop') props.push(name);
  }
  return props;
}

/** 解析 PROPPATCH 请求体：返回 { set: {prop: value}, remove: string[] } */
export function parseProppatch(xml: string): {
  set: Record<string, string | undefined>;
  remove: string[];
} {
  const result: { set: Record<string, string | undefined>; remove: string[] } = {
    set: {},
    remove: [],
  };

  // <set><prop><x:y>value</x:y></prop></set>
  const setMatch = xml.match(/<set\b[^>]*>([\s\S]*?)<\/set>/i);
  if (setMatch) {
    const propMatch = setMatch[1].match(/<prop\b[^>]*>([\s\S]*?)<\/prop>/i);
    const inner = propMatch ? propMatch[1] : setMatch[1];
    const re = /<([A-Za-z0-9_]+:)?([A-Za-z0-9_-]+)((?:\s[^>]*)?)>([\s\S]*?)<\/\1?\2>/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(inner)) !== null) {
      result.set[mm[2]] = mm[4].trim();
    }
  }

  // <remove><prop><x:y/></prop></remove>
  const removeMatch = xml.match(/<remove\b[^>]*>([\s\S]*?)<\/remove>/i);
  if (removeMatch) {
    const propMatch = removeMatch[1].match(/<prop\b[^>]*>([\s\S]*?)<\/prop>/i);
    const inner = propMatch ? propMatch[1] : removeMatch[1];
    const re = /<([A-Za-z0-9_]+:)?([A-Za-z0-9_-]+)(?:\s[^>]*)?\/?>/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(inner)) !== null) {
      if (!result.remove.includes(mm[2])) result.remove.push(mm[2]);
    }
  }

  return result;
}

/** XML 转义 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 构建单个 propstat 块 */
export function buildPropstat(propsXml: string, status: string): string {
  return `<D:propstat><D:prop>${propsXml}</D:prop><D:status>${status}</D:status></D:propstat>`;
}

/** 生成 multistatus 响应体 */
export function buildMultistatus(innerXml: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${innerXml}</D:multistatus>`;
}

/** 生成 DAV 错误响应体 */
export function buildErrorBody(davCode?: string, message?: string): string {
  const code = davCode ? `<D:${davCode}/>` : '';
  const msg = message ? `<D:responsedescription>${xmlEscape(message)}</D:responsedescription>` : '';
  return `<?xml version="1.0" encoding="utf-8"?><D:error xmlns:D="DAV:">${code}${msg}</D:error>`;
}
