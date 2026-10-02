/**
 * 회사 R&D 규제 모니터링 정책 로더.
 *
 * 원본 MCP 소스와 회사 정책 데이터를 분리해 upstream 병합 충돌을 최소화한다.
 * 런타임에서는 저장소 루트의 company-config/를 읽는다.
 */

import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface WatchLaw {
  name: string
  law_id: string
  current_mst: string
  domains: string[]
}

export interface WatchlistConfig {
  version: number
  purpose: string
  laws: WatchLaw[]
}

export interface ImpactClassification {
  id: string
  name: string
  signals: string[]
  default_action: string
}

export interface ImpactRulesConfig {
  version: number
  classification: ImpactClassification[]
  impact_domains: string[]
  decision_rules: string[]
}

export interface RndPolicy {
  watchlist: WatchlistConfig
  impactRules: ImpactRulesConfig
  outputSchema: string
}

function configRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    process.cwd(),
    resolve(here, "../.."),
  ]
}

async function readCompanyFile(name: string): Promise<string> {
  let lastError: unknown
  for (const root of configRoots()) {
    try {
      return await readFile(resolve(root, "company-config", name), "utf8")
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`company-config/${name}을 찾을 수 없습니다: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

export async function loadRndPolicy(): Promise<RndPolicy> {
  const [watchlistRaw, impactRaw, outputSchema] = await Promise.all([
    readCompanyFile("watchlist.json"),
    readCompanyFile("impact-rules.json"),
    readCompanyFile("output-schema.md"),
  ])

  return {
    watchlist: JSON.parse(watchlistRaw) as WatchlistConfig,
    impactRules: JSON.parse(impactRaw) as ImpactRulesConfig,
    outputSchema,
  }
}
