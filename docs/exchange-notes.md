# Exchange notes (Bybit public data only)

## Data sources

- Bybit **public market data**(티커/캔들/펀딩 등)만 사용한다.
- 인증/서명/주문 전송/계정 조회 등 **private endpoint 사용 금지**.

## Simulation details (planned)

- **수수료 반영**: maker/taker 가정치로 체결 비용 반영
- **펀딩비 반영**: 펀딩 타임 스케줄에 맞춰 포지션 PnL에 반영

## Limitations

- 실제 호가창/체결 슬리피지 모델은 초기 버전에서 단순화한다.
- 데이터 누락/지연은 로깅하고, 엔진은 안전하게 no-trade로 동작한다.

