# Fork 실행 지침

## 목표
원본 `chrisryugj/korean-law-mcp`를 최대한 유지하면서 회사 R&D 규제 모니터링 정책 레이어를 별도 디렉터리로 추가한다.

## 권장 저장소명
`rnd-regulation-mcp`

## 브랜치
- `main`: 회사 검증 완료 버전
- `upstream-sync`: 원본 업데이트 병합 전용
- `feature/rnd-policy`: 회사 정책 레이어 개발

## 첫 작업
1. GitHub에서 원본 저장소 Fork
2. Fork 저장소명을 `rnd-regulation-mcp`로 변경
3. 원본 저장소를 upstream으로 유지
4. 이 overlay 패키지의 `company-config/`, `docs/` 파일만 우선 추가
5. 원본 `src/`는 첫 단계에서 수정하지 않는다

## 원칙
- 원본 tool-registry, parser, search normalizer는 초기에 수정하지 않는다.
- 회사 고유 로직은 별도 모듈로 추가한다.
- upstream 업데이트 충돌을 최소화한다.
- 공개 Pilot endpoint는 검증용으로만 사용한다.
