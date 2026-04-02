# Risk rules (paper-only)

## Hard constraints

- **레버리지**: 2배 가정 (시뮬레이션 파라미터)
- **동시 포지션**: 1개만 허용 (BTCUSDT/ETHUSDT 중 1개)
- **롱 전용**: 초기 버전은 Long only
- **손절 필수**: 진입 시 손절가가 없으면 진입 금지
- **실주문 금지**: 인증키 저장/서명/주문 전송 등 실주문 기능 절대 금지

## Accounting assumptions

- **수수료**: maker/taker 수수료를 체결 시점에 반영
- **펀딩비**: 펀딩 타임마다 포지션에 비용/수익으로 반영 (추후)

