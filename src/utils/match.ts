import type { KeywordRule, MatchedKeyword } from '../types'

/** OCR 归一化：去掉所有空白，匹配更稳 */
export function normalizeOcrText(line: string): string {
  return line.replace(/[\s\u3000]+/g, '').trim()
}

/** 编译用户输入的正则，失败返回 null 并给出原因 */
export function compilePattern(pattern: string): { regex: RegExp | null; error: string | null } {
  try {
    return { regex: new RegExp(pattern, 'i'), error: null }
  } catch (err) {
    return { regex: null, error: err instanceof Error ? err.message : String(err) }
  }
}

export function isValidPattern(pattern: string): boolean {
  return compilePattern(pattern).regex !== null
}

export interface OcrTextLine {
  text: string
  score: number
}

/**
 * 在识别出的所有文字行上匹配关键字（OR 逻辑）。
 * 返回所有命中的规则；每条规则取第一个命中的上下文片段与置信度。
 *
 * 匹配策略：
 * 1. 逐行匹配（保留行内上下文与置信度）。
 * 2. 若逐行未命中，再对「所有行合并后的整段文本」匹配一次——
 *    OCR 可能把相邻字拆成不同的检测框/识别行（如“连”和“接”分属两行），
 *    合并后仍能命中，符合“画面上出现这些字就报警”的预期。
 */
export function findKeywordMatches(
  lines: OcrTextLine[],
  rules: KeywordRule[],
): MatchedKeyword[] {
  const hits: MatchedKeyword[] = []
  const normalized = lines.map((l) => normalizeOcrText(l.text))
  const fullText = normalized.join('')

  for (const rule of rules) {
    if (!rule.enabled) continue
    const { regex } = compilePattern(rule.pattern)
    if (!regex) continue

    let hit: MatchedKeyword | null = null

    for (let i = 0; i < normalized.length; i++) {
      const line = normalized[i]
      if (!line) continue
      regex.lastIndex = 0
      const match = regex.exec(line)
      if (match && match[0]) {
        hit = {
          rule,
          snippet: clipSnippet(line, match.index, match[0].length),
          score: lines[i]?.score ?? 0,
        }
        break
      }
    }

    if (!hit && fullText) {
      regex.lastIndex = 0
      const match = regex.exec(fullText)
      if (match && match[0]) {
        hit = {
          rule,
          snippet: clipSnippet(fullText, match.index, match[0].length),
          score: Math.max(0, ...lines.map((l) => l.score)),
        }
      }
    }

    if (hit) hits.push(hit)
  }
  return hits
}

function clipSnippet(text: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - 10)
  const end = Math.min(text.length, index + matchLen + 10)
  return text.slice(start, end)
}