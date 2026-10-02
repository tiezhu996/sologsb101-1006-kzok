/**
 * 备份文件指纹（sha256）：
 * - 同一备份重复合并时识别为同一批变化，不多记一条；
 * - 与导出基线绑定，三向合并时确认对端备份与基线同源。
 * 纯浏览器端计算（Web Crypto，subtle 仅要求安全上下文，localhost/容器内均可用）。
 */

export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** 读取文件文本并计算 sha256 */
export async function sha256File(file: File): Promise<{ text: string; hash: string }> {
  const text = await file.text()
  const hash = await sha256Text(text)
  return { text, hash }
}

/** 短指纹，仅用于界面展示 */
export function shortHash(hash: string): string {
  return hash.length >= 12 ? `${hash.slice(0, 6)}…${hash.slice(-6)}` : hash
}
