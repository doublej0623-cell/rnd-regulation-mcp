/**
 * rnd_regulation_analysis — company R&D regulation monitoring orchestrator.
 *
 * Reuses upstream tools without modifying their internals:
 * watchlist -> search_law_bulk -> MST change detection -> compare_old_new
 * -> deterministic policy signal assessment -> optional citation verification.
 *
 * Final legal applicability remains an LLM/human review step.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import type { LooseToolResponse } from "../lib/types.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatToolError } from "../lib/errors.js"
import { loadRndPolicy, assessRndRuleSignals, type RndWatchLaw } from "../lib/rnd-policy-loader.js"
import { searchLawBulk } from "./search-bulk.js"
import { compareOldNew } from "./comparison.js"
import { verifyCitations } from "./verify-citations.js"

export const RndRegulationAnalysisSchema = z.object({
  mode: z.enum(["scan_all", "analyze_one"]).default("scan_all")
    .describe("scan_all=회사 Watchlist 전체 변경감지, analyze_one=특정 법령 정밀점검"),
  lawName: z.string().max(200).optional()
    .describe("[analyze_one 필수] 점검할 법령명. Watchlist에 있는 법령 권장"),
  previousMst: z.string().max(50).optional()
    .describe("[analyze_one 선택] 비교 기준 MST. 미지정 시 Watchlist current_mst 사용"),
  includeUpcoming: z.boolean().optional().default(true)
    .describe("공포됐으나 아직 시행되지 않은 개정도 함께 확인"),
  claimText: z.string().max(50_000).optional()
    .describe("[선택] 법적 주장/보고문 문장을 추가로 인용검증할 때 사용"),
  apiKey: z.string().optional(),
})

export type RndRegulationAnalysisInput = z.infer<typeof RndRegulationAnalysisSchema>

interface BulkChange {
  lawName: string
  lawId: string
  previousMst?: string
  currentMst?: string
  effectiveDate?: string
  upcoming: boolean
}

function textOf(response: LooseToolResponse): string {
  return response.content.map(c => c.text).join("\n")
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")
}

function parseBulkChanges(text: string, laws: RndWatchLaw[]): BulkChange[] {
  const out: BulkChange[] = []

  for (const law of laws) {
    const name = escapeRegex(law.name)

    const changed = text.match(
      new RegExp(`△\\s+${name}\\s+\\|\\s+ID\\s+(\\S+)\\s+\\|\\s+MST\\s+(\\S+)\\s+→\\s+(\\S+)\\s+\\|\\s+시행\\s+([^\\n]+)`)
    )
    if (changed) {
      out.push({
        lawName: law.name,
        lawId: changed[1],
        previousMst: changed[2],
        currentMst: changed[3],
        effectiveDate: changed[4].trim(),
        upcoming: false,
      })
      continue
    }

    const added = text.match(
      new RegExp(`＋\\s+${name}\\s+\\|\\s+ID\\s+(\\S+)\\s+\\|\\s+MST\\s+(\\S+)\\s+\\|\\s+시행\\s+([^\\n]+)`)
    )
    if (added) {
      out.push({
        lawName: law.name,
        lawId: added[1],
        currentMst: added[2],
        effectiveDate: added[3].trim(),
        upcoming: false,
      })
      continue
    }

    const upcoming = text.match(
      new RegExp(`🔜\\s+${name}\\s+\\|\\s+ID\\s+(\\S+)\\s+\\|[^\\n]*시행예정 있음`)
    )
    if (upcoming) {
      out.push({
        lawName: law.name,
        lawId: upcoming[1],
        previousMst: law.current_mst,
        currentMst: law.current_mst,
        upcoming: true,
      })
    }
  }

  return out
}

function selectLaw(laws: RndWatchLaw[], name: string): RndWatchLaw | undefined {
  const normalized = name.replace(/\s+/g, "")
  return laws.find(l => l.name.replace(/\s+/g, "") === normalized)
    ?? laws.find(l => l.name.includes(name) || name.includes(l.name))
}

function policyHeader(): string {
  return [
    "## 판정 원칙",
    "- MST 변경 자체만으로 중요 규제변경으로 확정하지 않습니다.",
    "- 아래 '변경 성격 후보'는 규칙 기반 1차 분류이며 최종 법적 적용성 판단이 아닙니다.",
    "- 법령 원문 사실과 연구소 영향에 대한 AI/담당자 분석을 분리해야 합니다.",
    "- 별표·서식 수치는 원문을 직접 확인하고 추정하지 않습니다.",
  ].join("\n")
}

async function analyzeChange(
  apiClient: LawApiClient,
  law: RndWatchLaw,
  change: BulkChange,
  apiKey?: string,
): Promise<string> {
  let diffText = ""
  let diffError = false

  if (change.currentMst && change.currentMst !== change.previousMst) {
    const diff = await compareOldNew(apiClient, { mst: change.currentMst, lawId: change.lawId, apiKey })
    diffText = textOf(diff)
    diffError = Boolean(diff.isError)
  } else if (change.upcoming) {
    diffText = "현행 MST는 동일하고 시행예정 개정이 감지됐습니다. 시행예정 MST의 상세 비교는 원문/연혁 조회로 추가 확인이 필요합니다."
  } else {
    diffText = "비교할 MST 변경이 없습니다."
  }

  const assessment = assessRndRuleSignals(diffText, change.upcoming)

  return [
    `## ${law.name}`,
    `- 법령 ID: ${change.lawId || law.law_id}`,
    `- 이전 MST: ${change.previousMst || law.current_mst || "미확인"}`,
    `- 현재 MST: ${change.currentMst || "미확인"}`,
    `- 시행일: ${change.effectiveDate || "추가 확인 필요"}`,
    `- Watchlist 영향영역: ${law.domains.join(", ")}`,
    `- 변경 성격 후보: ${assessment.candidate}`,
    `- 규칙 매칭: ${assessment.matchedHints.length ? assessment.matchedHints.join(", ") : "없음"}`,
    `- 판정 메모: ${assessment.note}`,
    diffError ? "- ⚠️ 신구대조 API가 완전한 비교자료를 제공하지 못했습니다." : "",
    "",
    "### 원문 근거 / 신구대조",
    diffText,
    "",
    "### 연구소 영향 검토 상태",
    "- 최종 영향수준(영향 낮음/검토 필요/영향 있음): AI/담당자 검토 필요",
    "- 적용대상·예외·면제: 원문 근거 확인 후 판단",
    "- 필요 조치: 실질 변경이 확인되는 경우 사내 규정/허가·신고/시설·교육·기록 영향 검토",
  ].filter(Boolean).join("\n")
}

export async function rndRegulationAnalysis(
  apiClient: LawApiClient,
  input: RndRegulationAnalysisInput
): Promise<LooseToolResponse> {
  try {
    const policy = await loadRndPolicy()
    const { laws } = policy.watchlist

    const targets = input.mode === "analyze_one"
      ? (() => {
          if (!input.lawName) throw new Error("mode=analyze_one에는 lawName이 필요합니다.")
          const hit = selectLaw(laws, input.lawName)
          if (!hit) throw new Error(`Watchlist에서 법령을 찾지 못했습니다: ${input.lawName}`)
          return [hit]
        })()
      : laws

    const previous: Record<string, string> = {}
    for (const law of targets) {
      previous[law.law_id] = input.mode === "analyze_one" && input.previousMst
        ? input.previousMst
        : law.current_mst
    }

    const bulk = await searchLawBulk(apiClient, {
      queries: targets.map(l => l.name),
      previous,
      includeUpcoming: input.includeUpcoming,
      apiKey: input.apiKey,
    })
    const bulkText = textOf(bulk)

    const changes = parseBulkChanges(bulkText, targets)
    const sections: string[] = [
      "# R&D 연구소 법령 변경 점검",
      `- 모드: ${input.mode}`,
      `- 점검 법령: ${targets.length}건`,
      `- 변경/시행예정 후보: ${changes.length}건`,
      "",
      policyHeader(),
      "",
      "## 변경 감지 원문",
      bulkText,
    ]

    for (const change of changes) {
      const law = selectLaw(targets, change.lawName)
      if (!law) continue
      sections.push("", await analyzeChange(apiClient, law, change, input.apiKey))
    }

    if (changes.length === 0) {
      sections.push(
        "",
        "## 연구소 영향",
        "- 현재 Watchlist 기준으로 MST 변경 또는 시행예정 후보가 감지되지 않았습니다.",
        "- 검색 실패/부분매칭 경고가 있다면 해당 법령은 개별 재확인이 필요합니다."
      )
    }

    if (input.claimText) {
      const verification = await verifyCitations(apiClient, {
        text: input.claimText,
        maxCitations: 15,
        apiKey: input.apiKey,
      })
      sections.push("", "## 추가 주장 인용검증", textOf(verification))
    }

    sections.push(
      "",
      "## 표준 출력 후속 단계",
      "- [원문 사실] 조문/별표 변경내용과 법령 ID·MST·시행일을 확정",
      "- [AI 분석] 연구소 적용여부·영향영역·필요조치를 별도 작성",
      "- 중요한 판단은 담당부서/법무·환경안전 검토를 거쳐 확정"
    )

    return { content: [{ type: "text", text: truncateResponse(sections.join("\n")) }] }
  } catch (error) {
    return formatToolError(error, "rnd_regulation_analysis")
  }
}
