/**
 * Company R&D regulation policy loader.
 *
 * Keeps company-specific monitoring scope and classification rules outside
 * the upstream Korean-law-mcp core so upstream syncs stay low-conflict.
 */

import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface RndWatchLaw {
  name: string
  law_id: string
  current_mst: string
  domains: string[]
}

export interface RndWatchlist {
  version: number
  purpose?: string
  laws: RndWatchLaw[]
}

export interface RndClassificationRule {
  id: "FORMAL_ONLY" | "SUBSTANTIVE" | "UPCOMING" | string
  name: string
  signals: string[]
  default_action: string
}

export interface RndImpactRules {
  version: number
  classification: RndClassificationRule[]
  impact_domains: string[]
  decision_rules: string[]
}

export interface RndPolicy {
  watchlist: RndWatchlist
  impactRules: RndImpactRules
}

const moduleDir = dirname(fileURLToPath(import.meta.url))

function candidateConfigDirs(): string[] {
  const dirs = [
    process.env.RND_REGULATION_CONFIG_DIR,
    resolve(process.cwd(), "company-config"),
    // build/lib/rnd-policy-loader.js -> repository/package root
    resolve(moduleDir, "../../company-config"),
  ].filter((v): v is string => Boolean(v))

  return [...new Set(dirs)]
}

async function readJsonFromConfig<T>(fileName: string): Promise<T> {
  const tried: string[] = []

  for (const dir of candidateConfigDirs()) {
    const path = resolve(dir, fileName)
    tried.push(path)
    try {
      const raw = await readFile(path, "utf-8")
      return JSON.parse(raw) as T
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") continue
      throw new Error(`R&D 규제 설정 파일을 읽지 못했습니다: ${path} (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  throw new Error(
    `R&D 규제 설정 파일을 찾지 못했습니다: ${fileName}\n확인한 경로:\n- ${tried.join("\n- ")}\nRND_REGULATION_CONFIG_DIR 환경변수로 경로를 지정할 수 있습니다.`
  )
}

function validateWatchlist(value: RndWatchlist): RndWatchlist {
  if (!Array.isArray(value?.laws) || value.laws.length === 0) {
    throw new Error("company-config/watchlist.json의 laws가 비어 있습니다.")
  }
  for (const law of value.laws) {
    if (!law.name || !law.law_id || !law.current_mst) {
      throw new Error("watchlist 법령에는 name, law_id, current_mst가 필요합니다.")
    }
  }
  return value
}

function validateImpactRules(value: RndImpactRules): RndImpactRules {
  if (!Array.isArray(value?.classification) || !Array.isArray(value?.impact_domains)) {
    throw new Error("company-config/impact-rules.json 형식이 올바르지 않습니다.")
  }
  return value
}

export async function loadRndPolicy(): Promise<RndPolicy> {
  const [watchlist, impactRules] = await Promise.all([
    readJsonFromConfig<RndWatchlist>("watchlist.json"),
    readJsonFromConfig<RndImpactRules>("impact-rules.json"),
  ])

  return {
    watchlist: validateWatchlist(watchlist),
    impactRules: validateImpactRules(impactRules),
  }
}

const FORMAL_HINTS = [
  "부처명", "직제", "용어 정비", "오탈자", "명칭 변경",
  "환경부", "기후에너지환경부", "산업통상자원부", "산업통상부",
]

const SUBSTANTIVE_HINTS = [
  "하여야", "해서는 아니", "금지", "허가", "신고", "검사", "점검",
  "주기", "기준", "이상", "이하", "초과", "미만", "별표",
  "과태료", "벌금", "징역", "교육", "기록", "보고",
]

export interface RndRuleAssessment {
  candidate: "FORMAL_ONLY" | "SUBSTANTIVE" | "UPCOMING" | "REVIEW_REQUIRED"
  matchedHints: string[]
  note: string
}

/**
 * Deterministic pre-classification only.
 * Final "research-center impact" is deliberately left to the LLM/human review.
 */
export function assessRndRuleSignals(text: string, upcoming = false): RndRuleAssessment {
  if (upcoming) {
    return {
      candidate: "UPCOMING",
      matchedHints: ["시행예정"],
      note: "시행예정 버전입니다. 시행일 전 영향평가가 필요합니다.",
    }
  }

  const formal = FORMAL_HINTS.filter(k => text.includes(k))
  const substantive = SUBSTANTIVE_HINTS.filter(k => text.includes(k))

  if (substantive.length > 0) {
    return {
      candidate: "SUBSTANTIVE",
      matchedHints: substantive,
      note: "실질 변경 신호가 포함되어 있습니다. 규칙 기반 후보이며 최종 판단은 원문 검토가 필요합니다.",
    }
  }

  if (formal.length > 0) {
    return {
      candidate: "FORMAL_ONLY",
      matchedHints: formal,
      note: "형식 변경 신호가 우세합니다. 다른 실질 변경이 없는지 원문 확인이 필요합니다.",
    }
  }

  return {
    candidate: "REVIEW_REQUIRED",
    matchedHints: [],
    note: "키워드만으로 변경 성격을 확정할 수 없습니다. AI/담당자 검토가 필요합니다.",
  }
}
