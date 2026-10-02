# Upstream 동기화 운영안

## 권장 흐름
1. 원본 `chrisryugj/korean-law-mcp` release/commit 확인
2. `upstream-sync` 브랜치에서 병합
3. `npm run typecheck`
4. `npm test`
5. `npm run build`
6. 회사 규제 테스트 3종 재수행
   - 개정 diff
   - citation verification
   - search_law_bulk
7. 이상 없으면 `main` 반영

## 변경 최소화
원본 검색 정규화/법령 파서 계층은 특별한 이유가 없으면 직접 수정하지 않는다.
