/**
 * rnd_regulation_analysis — 회사 R&D 규제변경 점검 오케스트레이션 도구.
 *
 * 원본 Korean Law MCP의 검색/개정추적/인용검증 기능을 재구현하지 않고 조합한다.
 * 회사 watchlist와 impact rules를 별도 설정으로 읽어 upstream 수정 범위를 최소화한다.
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import type { LooseToolResponse } from "../lib/types.js"
import { searchLawBulk } from "./search-bulk.js"
import { chainAmendmentTrack } from "./chains.js"
import { verifyCitations } from "./verify-citations.js"
import { loadRndPolicy, type ImpactRulesConfig, type WatchLaw } from "../lib/rnd-policy-loader.js"

export const RndRegulationAnalysisSchema = z.object({
  mode: z.enum(["scan_all", "analyze_one"]).default("scan_all")
    .describe("scan_all=회사 Watchlist 전체 변경점검, analyze_one=특정 법령 정밀분석"),
  lawName: z.string().max(200).optional()
    .describe("[analyze_one 필수] 분석할 법령명"),
  focus: z.string().max(200).optional()
    .describe("분석 초점. 예: 연구소, 화학물질, 취급시설, 폐기물, 안전"),
  previous: z.record(z.string(), z.string()).optional()
    .describe("[scan_all 선택] {법령ID: 직전MST} 스냅샷. 없으면 company-config/watchlist.json 기준값 사용"),
  previousMst: z.string().optional()
    .describe("[analyze_one 선택] 사용자가 별도로 지정할 직전 MST"),
  includeUpcoming: z.boolean().optional().default(true)
    .describe("시행예정 개정본도 함께 확인"),
  maxDetailed: z.number().int().min(1).max(5).optional().default(3)
    .describe("[scan_all] 변경 법령 중 상세 개정추적할 최대 건수"),
  verifyEvidence: z.boolean().optional()
    .describe("개정추적 결과에 포함된 법령 인용을 추가 검증. analyze_one 기본 true, scan_all 기본 false"),
  apiKey: z.string().optional(),
})

export type RndRegulationAnalysisInput = z.infer<typeof RndRegulationAnalysisSchema>

interface ChangedLaw {
  name: string
  lawId: string
  previousMst: string
  currentMst: string
  kind: "current" | "upcoming"
}

function responseText(result: LooseToolResponse): string {
  return result.content?.[0]?.text || ""
}

function watchlistPrevious(laws: WatchLaw[]): Record<string, string> {
  return Object.fromEntries(laws.map(law => [law.law_id, law.current_mst]))
}

function parseChangedLaws(text: string): ChangedLaw[] {
  const rows: ChangedLaw[] = []

  const currentRe = /^△\s+(.+?)\s+\|\s+ID\s+(\d+)\s+\|\s+MST\s+(\d+)\s+→\s+(\d+)/gm
  let match: RegExpExecArray | null
  while ((match = currentRe.exec(text)) !== null) {
    rows.push({
      name: match[1].trim(),
      lawId: match[2],
      previousMst: match[3],
      currentMst: match[4],
      kind: "current",
    })
  }

  const upcomingBlockRe = /^🔜\s+(.+?)\s+\|\s+ID\s+(\d+)\s+\|\s+본문 동일\(MST\s+(\d+)\)\s+—\s+시행예정 있음\n((?:\s+🔜.*\n?)*)/gm
  while ((match = upcomingBlockRe.exec(text)) !== null) {
    const name = match[1].trim()
    const lawId = match[2]
    const currentMst = match[3]
    const block = match[4]
    const futureMsts = [...block.matchAll(/\(MST\s+(\d+),/g)].map(m => m[1])
    for (const futureMst of futureMsts) {
      rows.push({
        name,
        lawId,
        previousMst: currentMst,
        currentMst: futureMst,
        kind: "upcoming",
      })
    }
  }

  return rows
}

function parseCurrentIdentity(text: string): { lawId?: string; mst?: string; upcomingMsts: string[] } {
  const m = text.match(/ID\s+(\d+)\s+\|\s+MST\s+(\d+)/)
  const upcomingMsts = [...text.matchAll(/시행예정[^\n]*\(MST\s+(\d+),/g)].map(match => match[1])
  return m ? { lawId: m[1], mst: m[2], upcomingMsts } : { upcomingMsts }
}

function preliminaryClassification(text: string, rules: ImpactRulesConfig): string {
  const substantive = rules.classification.find(r => r.id === "SUBSTANTIVE")
  const formal = rules.classification.find(r => r.id === "FORMAL_ONLY")
  const upcoming = rules.classification.find(r => r.id === "UPCOMING")

  const substantiveHits = substantive?.signals.filter(signal => text.includes(signal)) ?? []
  const formalHits = formal?.signals.filter(signal => text.includes(signal)) ?? []
  const upcomingHits = upcoming?.signals.filter(signal => text.includes(signal)) ?? []

  const labels: string[] = []
  if (substantiveHits.length > 0) labels.push(`실질적 변경 후보(${substantiveHits.join(", ")})`)
  else if (formalHits.length > 0) labels.push(`형식적 변경 후보(${formalHits.join(", ")})`)
  else labels.push("규칙만으로 자동판정 불가 — 원문 검토 필요")
  if (upcomingHits.length > 0 || /시행예정/.test(text)) labels.push("시행예정 사항 포함")

  return labels.join(" / ")
}

async function verifyIfRequested(
  apiClient: LawApiClient,
  text: string,
  enabled: boolean,
  apiKey?: string,
): Promise<string> {
  if (!enabled || !text.trim()) return ""
  const verified = await verifyCitations(apiClient, {
    text,
    maxCitations: 20,
    apiKey,
  })
  return responseText(verified)
}

function policyFooter(
  focus: string | undefined,
  rules: ImpactRulesConfig,
  outputSchema: string,
): string {
  return [
    "═══ 회사 R&D 영향분석 규칙 ═══",
    `분석 초점: ${focus || "연구소 전반"}`,
    `영향영역: ${rules.impact_domains.join(" / ")}`,
    "",
    "판단 원칙:",
    ...rules.decision_rules.map((rule, i) => `${i + 1}. ${rule}`),
    "",
    "아래 표준 포맷으로 최종 답변을 작성하세요. [원문 사실]과 [AI 분석]을 섞지 마세요.",
    outputSchema.trim(),
  ].join("\n")
}

export async function rndRegulationAnalysis(
  apiClient: LawApiClient,
  input: RndRegulationAnalysisInput,
): Promise<LooseToolResponse> {
  try {
    const policy = await loadRndPolicy()

    if (input.mode === "analyze_one") {
      if (!input.lawName) {
        return {
          content: [{ type: "text", text: "mode=analyze_one에는 lawName이 필요합니다." }],
          isError: true,
        }
      }

      const watch = policy.watchlist.laws.find(law =>
        law.name.replace(/\s/g, "") === input.lawName!.replace(/\s/g, "")
      )
      const baselineMst = input.previousMst || watch?.current_mst

      const currentResult = await searchLawBulk(apiClient, {
        queries: [input.lawName],
        includeUpcoming: input.includeUpcoming,
        apiKey: input.apiKey,
      })
      const currentText = responseText(currentResult)
      const identity = parseCurrentIdentity(currentText)

      let changeCheck = ""
      if (identity.lawId && baselineMst) {
        changeCheck = responseText(await searchLawBulk(apiClient, {
          queries: [input.lawName],
          previous: { [identity.lawId]: baselineMst },
          includeUpcoming: input.includeUpcoming,
          apiKey: input.apiKey,
        }))
      }

      const amendment = await chainAmendmentTrack(apiClient, {
        query: input.lawName,
        mst: identity.mst,
        lawId: identity.lawId,
        includeHistory: false,
        apiKey: input.apiKey,
      })
      const amendmentText = responseText(amendment)
      const upcomingSections: string[] = []
      for (const upcomingMst of identity.upcomingMsts.slice(0, input.maxDetailed)) {
        const upcoming = await chainAmendmentTrack(apiClient, {
          query: input.lawName,
          mst: upcomingMst,
          lawId: identity.lawId,
          includeHistory: false,
          apiKey: input.apiKey,
        })
        upcomingSections.push(`[시행예정 MST ${upcomingMst}]\n${responseText(upcoming)}`)
      }

      const evidenceText = [amendmentText, ...upcomingSections].join("\n\n")
      const verify = input.verifyEvidence ?? true
      const verificationText = await verifyIfRequested(apiClient, evidenceText, verify, input.apiKey)

      const body = [
        "═══ R&D 규제 정밀분석 원자료 ═══",
        "",
        "▶ 현재 법령 상태",
        currentText,
        changeCheck ? "\n▶ Watchlist 기준 변경 여부\n" + changeCheck : "",
        "\n▶ 최근 개정 추적 / 신구대조",
        amendmentText,
        upcomingSections.length > 0 ? "\n▶ 시행예정 개정 상세\n" + upcomingSections.join("\n\n") : "",
        `\n▶ 규칙 기반 1차 분류\n${preliminaryClassification(evidenceText + "\n" + currentText, policy.impactRules)}`,
        verificationText ? "\n▶ 인용 검증\n" + verificationText : "",
        "\n" + policyFooter(input.focus, policy.impactRules, policy.outputSchema),
      ].filter(Boolean).join("\n")

      return { content: [{ type: "text", text: body }] }
    }

    const previous = input.previous || watchlistPrevious(policy.watchlist.laws)
    const bulk = await searchLawBulk(apiClient, {
      queries: policy.watchlist.laws.map(law => law.name),
      previous,
      includeUpcoming: input.includeUpcoming,
      apiKey: input.apiKey,
    })
    const bulkText = responseText(bulk)
    const changed = parseChangedLaws(bulkText).slice(0, input.maxDetailed)
    const detailSections: string[] = []

    for (const law of changed) {
      const amendment = await chainAmendmentTrack(apiClient, {
        query: law.name,
        mst: law.currentMst,
        lawId: law.lawId,
        includeHistory: false,
        apiKey: input.apiKey,
      })
      const amendmentText = responseText(amendment)
      const verify = input.verifyEvidence ?? false
      const verificationText = await verifyIfRequested(apiClient, amendmentText, verify, input.apiKey)
      detailSections.push([
        `▶ ${law.name} ${law.kind === "upcoming" ? "시행예정" : "현행 변경"} 상세 (MST ${law.previousMst} → ${law.currentMst})`,
        amendmentText,
        `규칙 기반 1차 분류: ${preliminaryClassification(amendmentText, policy.impactRules)}`,
        verificationText ? "인용 검증:\n" + verificationText : "",
      ].filter(Boolean).join("\n"))
    }

    const body = [
      "═══ R&D 법령 Watchlist 변경 점검 ═══",
      `Watchlist: ${policy.watchlist.laws.length}개 법령`,
      `상세 분석: 변경 법령 최대 ${input.maxDetailed}건`,
      "",
      "▶ 변경 감지",
      bulkText,
      detailSections.length > 0
        ? "\n═══ 변경 법령 상세 분석 원자료 ═══\n" + detailSections.join("\n\n")
        : "\n변경된 현행 MST가 없어 상세 개정추적은 생략했습니다.",
      "\n" + policyFooter(input.focus, policy.impactRules, policy.outputSchema),
    ].join("\n")

    return { content: [{ type: "text", text: body }] }
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `R&D 규제분석 실행 실패: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    }
  }
}
