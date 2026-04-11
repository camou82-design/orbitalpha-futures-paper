# OrbitAlpha 선물 페이퍼 트레이딩 운영 매뉴얼 (OPERATIONS.md)

본 문서는 `orbitalpha-futures-paper` 엔진 및 API 서비스의 안정적인 운영을 위한 가이드를 제공합니다.

---

## 🚀 1. 서비스 관리 (Lightsail)

본 서비스는 AWS Lightsail 인스턴스에서 PM2를 통해 관리됩니다.

### PM2 명령어
- **서비스 상태 확인**: `pm2 status`
- **전체 재시작 (코드 업데이트 후)**: `pm2 restart all`
- **로그 실시간 모니터링**: `pm2 logs lightsail-futures-paper-api`
- **특정 서비스 재시작**: `pm2 restart lightsail-futures-paper-api`

### 인스턴스 정보
- **Public IP**: `3.36.36.35`
- **Domain**: `paper-api.orbitalpha.kr`
- **포트**: 80 (HTTP), 443 (HTTPS - Nginx Reverse Proxy)

---

## 📂 2. 데이터 및 상태 파일 관리

엔진의 모든 상태는 `data/` 디렉토리에 JSON 형태로 저장됩니다.

- **`data/engine-state.json`**: 엔진의 전역 상태 (현재 레짐, 리스크 상태 등)
- **`data/positions/open.json`**: 현재 보유 중인 포지션 정보 (평균단가, 진입단계, 손절가 포함)
- **`data/positions/history.json`**: 종료된 모든 거래 이력 (원장)
- **`data/events/`**: 엔진에서 발생한 주요 결정 및 AI 차단 이력

> [!IMPORTANT]
> 서버 점검 시 `open.json`을 백업해두면 프로세스 재시작 후에도 포지션을 그대로 유지할 수 있습니다.

---

## 🛠️ 3. 장애 조치 (Troubleshooting)

### "데이터 경로 미설정 / fetch 실패" 발생 시
1. **서버 응답 확인**: 브라우저에서 `https://paper-api.orbitalpha.kr/health` 접속
2. **Nginx 상태 확인**: `sudo systemctl status nginx`
3. **PM2 프로세스 확인**: `pm2 status`로 `online`인지 확인
4. **Vercel 환경변수 확인**: 
   - `ORBITALPHA_FUTURES_PAPER_API_URL` 가 `https://paper-api.orbitalpha.kr` 인지 확인
   - `ORBITALPHA_FUTURES_PAPER_API_SECRET` 이 서버의 `API_SECRET`과 일치하는지 확인

### 엔진이 진입을 하지 않을 때
- `data/engine-state.json`의 `risk_state`가 `BLOCKED`인지 확인 (연속 손실 또는 일일 손실 제한)
- `cooldown_active`가 `true`인지 확인
- 로그(`pm2 logs`)에서 `decision_blocked` 사유 확인

---

## 📈 4. 수식 및 로직 검증

- **평균단가**: `(기존금액 + 추가금액) / 총수량` 으로 매 단계 재계산됨
- **손절**: ATR 기반 동적 스탑 (Range: 0.5 ATR, Trend: 1.5 ATR)
- **분할익절**: 3단계 (30% / 40% / 잔량)

---
**최종 업데이트**: 2026-04-10
**담당**: Antigravity (Advanced Agentic AI)
