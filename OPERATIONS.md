1. 매매 프로그램 업그레이드 작업
1-1. 시스템 기반 분석

먼저 현재 엔진 구조를 기준으로 아래를 확인해 주세요.

기존 시스템이 Scaling(추가진입) 을 지원하는지 확인
포지션 보유 중 추가진입 시 평균단가 재계산이 가능한지 확인
부분청산(Partial Exit) 지원 여부 확인
상태 파일(engine-state.json, open.json)이 stage 기반 상태를 담을 수 있는지 확인
목표
다단계 진입/청산 구조를 안정적으로 올릴 수 있는 기반인지 판단
엔진 확장 포인트와 수정 범위를 명확히 파악
1-2. 다단계 진입 로직 설계

전량 진입이 아니라 선진입 + 확인추가진입 구조로 설계해 주세요.

RANGE
1차: 25% 선진입
2차: 35% 확인추가
3차: 40% 확정추가
TREND
1차: 30% 선진입
2차: 30% 눌림/확인추가
3차: 40% 재돌파 확정추가
구현 원칙
stage별 진입 사유 기록
평균단가 자동 재계산
현재 진입 단계 추적
다음 단계 진입 조건 명시
1-3. 엔진 통합 및 Scale-in 구현

기존 포지션이 열려 있는 상태에서도 추가진입이 가능하도록 엔진을 통합해 주세요.

필수 구현 사항
기존 포지션 보유 중 Scale-in 허용
stage별 incremental size 계산
weighted average entry price 계산
누적 sizeUsd 갱신
진입 stage 진행 상태 저장
1-4. 전략 고도화 (Execution Engine 모델)
RANGE 전략
박스 하단/상단 관심구역 진입
최소 반응 확인 후 stage 진입
박스 중심선 기준 분할익절
박스 이탈 + ATR 버퍼 손절
TREND 전략
EMA20 첫 눌림/되돌림 진입
반등/재하락 확인 후 추가진입
전고점/전저점 돌파 시 최종 비중 확대
RR + ATR 트레일링 기반 청산
목표
단순 지표 확인형이 아니라, 장세별 실행형 전략으로 고도화
1-5. ATR 기반 동적 손절 구현

고정 퍼센트 손절은 제거하고 ATR 기반 동적 손절로 통일해 주세요.

구현 원칙
stage 진입 시마다 손절 재계산
RANGE / TREND 별 ATR multiplier 분리
평균단가 갱신 후 stopPrice 재설정
필요 시 breakeven 보호 로직 검토
목표
변동성에 맞는 손절 구조 확보
과도한 손절/과도한 방치 방지
1-6. 3단계 분할 익절(Scale-out) 구현
RANGE
1차 익절: 박스 중심선 70~90%
2차 익절: 박스 중심선 도달
3차 익절: 잔량 운영 후 실패 시 청산
TREND
1차 익절: RR 1.0
2차 익절: RR 1.5 ~ 2.0
3차 익절: ATR 트레일링
구현 내용
부분청산 시 qty / sizeUsd 감소
realizedPnl 누적
잔여 포지션 상태 유지
exit stage 추적
1-7. RANGE / TREND 전략 상세 고도화

각 전략이 단순 stage 구조에 그치지 않고, 실제 장세 특성을 반영하도록 세부 로직을 보완해 주세요.

보완 방향
RANGE는 빠른 반응, 짧은 손절, 짧은 익절 중심
TREND는 일부 수익 확보 후 잔량 추세 추적 중심
stage 1 실패율과 stage 2~3 확장 비율도 같이 확인
1-8. NO_TRADE 적극 회피 로직

애매한 구간은 RANGE/TREND로 억지 분류하지 말고 적극적으로 회피해 주세요.

회피 대상
방향성 불명확
변동성 급등
휩쏘 우려
추세/박스 모두 불완전한 구간
목표
불필요한 손절 감소
엔진 신뢰도 향상
2. 데이터 구조 및 가이드 문구 고도화
2-1. engine-state.json 확장

다음 필드를 포함해 주세요.

nextAction
invalidateCondition
riskNote
entryProgress
exitProgress
guidance
targetStage
2-2. open.json 확장

다음 필드를 포함해 주세요.

targetPrices
unrealizedPnl
unrealizedPnlPct
realizedPnl
entryStage
partialExitStage
stopPrice
trailingStop
목표
프론트에 엔진 상태를 충분히 전달
단계별 진행상황과 손익을 정확히 표시 가능하도록 구조화
2-3. 행동형 가이드 문구(Actionable Guidance) 생성 로직

지표 설명이 아니라 현재 무엇을 해야 하는지를 바로 이해할 수 있는 문장을 생성해 주세요.

예시
현재 상태: RANGE 하단 관심구역 1차 진입 완료
다음 행동: 반전 확인 시 2차 진입
무효 조건: 하단 이탈 시 시나리오 폐기
리스크: 변동성 확대 구간으로 신규 진입 보수 적용

또는

현재 상태: TREND 눌림목 2차 진입 완료
다음 행동: 전고점 돌파 시 최종 비중 확대
1차 익절: 103,800원
손절: 101,700원
목표
사용자가 지표 해석 없이 현재 상태와 다음 행동을 바로 이해하도록 만들기
3. 대시보드 UI/UX 전면 개편
3-1. 진입/익절 단계 시각화

다음 항목을 Badge 또는 Progress 형태로 시각화해 주세요.

Entry Stage 1 / 2 / 3
Exit Stage 1 / 2 / 3
3-2. 상세 행동 가이드 박스 추가

가장 잘 보이는 위치에 가이드 박스를 배치해 주세요.

반드시 보여야 할 정보
평균 매수가
현재가
1차/2차 목표가
손절가
현재 손익액
현재 수익률
현재 진입 단계
현재 익절 단계
다음 행동 가이드
무효 조건
리스크 노트
UI 원칙
승률보다 손익 우선
지표 숫자는 최소화
초보자도 바로 이해 가능한 화면
지금 얼마에 사고, 얼마에 팔고, 얼마 벌고/잃고 있는지가 먼저 보여야 함
4. 최종 검증 및 보고
4-1. 스케일링/분할익절 수식 검증 (설계 단계 포함)

아래 수식을 반드시 검증해 주세요.

진입
weighted average entry price 계산
stage별 incremental sizeUsd 계산
cumulative sizeUsd 누적
청산
partial exit 후 잔여 수량 계산
realizedPnl 누적 계산
unrealizedPnl 계산
partialExitStage 증가 로직
리스크
ATR 기반 stopPrice 재계산
trailing stop 이동 로직
RANGE / TREND별 ATR multiplier 적용
4-2. 실전형 가이드 메시지 확인

가이드 문구가 너무 기술적이지 않고 실제 행동 판단에 도움이 되는지 확인해 주세요.

확인 항목
대기 / 진입 / 추가진입 / 익절 / 손절 상황별 문구가 자연스러운지
문장이 너무 내부 지표 설명 위주가 아닌지
사용자가 다음 행동을 바로 이해할 수 있는지
[Final Phase] 운영 안정화 및 마감
5. Lightsail 서버 복구 및 접근성 확보

현재 최우선 과제입니다.
새 기능 추가보다 먼저 처리해 주세요.

확인 항목
인스턴스 상태 재점검
Public IP / 고정 IP 상태 확인
방화벽 / 포트(80, 443) 상태 확인
SSH 접속 복구
서비스 포트 통신 복구
목표
외부에서 서버 및 대시보드 접근 가능 상태 복구
엔진 배포 및 실구동 확인 가능 상태 확보
6. 서버 실구동 검증

Lightsail 복구 후 아래를 바로 확인해 주세요.

확인 항목
엔진 루프 정상 실행 여부
ATR 계산 정상 여부
상태 파일(engine-state.json, open.json) 갱신 여부
guidance / nextAction / invalidateCondition / riskNote 반영 여부
대시보드 정상 렌더링 여부
Entry / Exit stage 시각화 정상 동작 여부
7. 수식 및 로직 최종 검증
꼭 확인할 항목
평단가(Weighted Avg) 계산 정확성
미실현손익 / 실현손익 계산 정확성
부분 익절 후 잔여 수량 정상 반영
ATR 기반 트레일링 스탑 정상 작동
추가진입 후 stopPrice 재설정 정상 여부
8. 시나리오 테스트 (Scenario 1~6)

아래 시나리오를 실제로 돌려서 결과를 검증해 주세요.

Scenario 1
Stage 1만 진입 후 손절
손실액 및 상태 초기화 확인
Scenario 2
Stage 1 → 2 → 3 진입 완료
평균단가 및 stopPrice 재조정 확인
Scenario 3
Exit 1 부분 익절
realizedPnl 누적 확인
Scenario 4
Exit 2 추가 익절
partialExitStage 반영 확인
Scenario 5
Exit 3 ATR 트레일링 종료
최종 청산 후 포지션 종료 확인
Scenario 6
NO_TRADE 구간
신규 진입이 발생하지 않는지
guidance가 대기/관망 문구로 출력되는지 확인
9. UI 최종 마감 (가이드 문구 고도화)

기능보다 사용성을 최종 점검하는 단계입니다.

목표
가이드 문구 자연스럽게 다듬기
상태 변화에 따라 문구가 즉시 바뀌도록 보완
지표 설명보다 행동 가이드가 먼저 보이도록 정리
단계/손익/행동이 한눈에 들어오는 화면으로 마감
10. 운영 매뉴얼 작성 (장애 복구 가이드)

최종적으로 아래 내용을 운영 문서로 남겨 주세요.

문서화할 내용
Lightsail 장애 시 복구 순서
SSH 접속 복구 순서
엔진 재시작 방법
pm2/systemd 확인 방법
상태 파일 확인 위치
대시보드 점검 순서
배포 후 확인 항목
이상 징후 발생 시 대응 기준
목표
이후 장애나 재배포 시 누구나 같은 절차로 대응 가능하게 만들기
11. 최종 우선순위
1순위
Lightsail 복구
서버 실구동 확인
상태 파일 갱신 확인
대시보드 렌더링 확인
2순위
수식 검증
Scale-in / Scale-out 검증
ATR 손절 / 트레일링 검증
Scenario 1~6 테스트 완료
3순위
UI 최종 마감
가이드 문구 고도화
운영 매뉴얼 작성
최종 결과 보고
12. 완료 기준

아래가 모두 충족되면 이번 후속 작업을 완료로 간주합니다.

Lightsail 서버 접근 복구 완료
엔진 루프 정상 실행
engine-state.json, open.json 정상 갱신
Scale-in / Scale-out 정상 작동
ATR 기반 손절 / 트레일링 정상 작동
realizedPnl / unrealizedPnl 계산 정확
UI에서 단계 / 손익 / 가이드 문구 정상 표시
Scenario 1~6 테스트 통과
운영 매뉴얼 작성 완료