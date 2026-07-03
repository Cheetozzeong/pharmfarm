# PharmFarm 운영형 에이전트 준비 문서

## 1. 목표

PharmFarm 에이전트는 약국 PC에서 기존 약국 프로그램의 로컬 SQL Server DB를 읽어, 조제 완료 또는 QR 등록 이후 생성된 처방 약품 데이터를 PharmFarm 서버로 안정적으로 전송하는 Windows용 로컬 프로그램이다.

운영형 에이전트의 목표는 다음이다.

- 약국 직원의 추가 OCR 촬영/수기 입력 없이 처방 약품 데이터를 수집한다.
- 약국 프로그램 DB에는 쓰기 작업을 하지 않고 읽기 전용으로만 동작한다.
- 환자 식별 가능 정보를 최대한 수집하지 않는다.
- 네트워크 장애가 있어도 데이터가 유실되지 않도록 로컬 큐를 둔다.
- 중복 전송이 발생해도 서버에서 안전하게 무시할 수 있도록 idempotency key를 사용한다.
- 설치, 실행, 로그 확인, 재시작이 약국 PC 환경에서 단순해야 한다.

## 2. 현재 테스트 에이전트 상태

현재 `windows-agent-portable/PharmFarm-SqlAgent.ps1`는 테스트/분석용 PowerShell 에이전트다.

현재 가능한 동작:

- SQL Server 인스턴스 탐색
- EPharm DB 목록 확인
- DB 구조 스냅샷 전송
- QR 원문 후보 검색
- `eP_ERROR_LOG.dbo.PRESCRIPT_EDB` 최근 행 감시
- `eP_PHARM.dbo.prsdrug`와 조인하여 약품 상세 데이터 전송

운영형으로 바로 쓰기 어려운 지점:

- 진단용 모드가 많고 약국 PC에서 잘못 실행될 여지가 있다.
- API 전송 실패 시 로컬에 안전하게 보관하는 큐가 없다.
- `rawQrText`, `knownPlainText`, `rawBlock` 등에 원문/상세 JSON이 남을 수 있다.
- 인증 토큰/기기 식별/서명 검증 구조가 부족하다.
- 에이전트 상태를 서버나 UI에서 확인하기 어렵다.
- 배치 창 기반이라 장시간 운영, 자동 재시작, 업데이트 관리가 약하다.

## 3. 운영형 에이전트 권장 방향

### 3.1 추천 구현 방식

1차 운영 버전은 Windows 전용 단일 실행 파일 형태가 적합하다.

추천 스택:

- .NET 8 Worker Service
- Windows Service 설치 지원
- Self-contained single-file exe 배포
- SQL Server 접근은 Microsoft.Data.SqlClient 사용
- 로컬 큐는 SQLite 또는 암호화 JSONL 사용
- 설정/토큰 암호화는 Windows DPAPI 사용

이유:

- 약국 PC에 Git, npm, Node 설치가 없어도 실행 가능하다.
- Windows 서비스로 자동 시작/재시작이 가능하다.
- SQL Server, Windows 인증, DPAPI, 이벤트 로그 연동이 자연스럽다.
- 장기 운영 시 PowerShell보다 장애 대응과 배포 관리가 쉽다.

단기 테스트는 현재 PowerShell을 유지할 수 있지만, 정식 운영형은 별도 `pharmfarm-agent` 프로젝트로 분리하는 것이 좋다.

## 4. 운영형에서 제거해야 할 기능

운영 에이전트에는 아래 기능을 넣지 않는 것이 좋다.

- 전체 DB 스냅샷 전송
- 모든 텍스트 컬럼 QR 검색
- QR 원문 전체 저장
- DB 테이블/컬럼 카탈로그 전송
- 환자명, 병원명, 전화번호, 주소 등 직접 식별자 수집
- 디버깅용 raw JSON 장기 저장

운영 에이전트는 아래 두 테이블 중심으로만 동작하는 것을 기본값으로 둔다.

- `eP_ERROR_LOG.dbo.PRESCRIPT_EDB`
- `eP_PHARM.dbo.prsdrug`

필요 시 약품명 매칭을 위해 아래 테이블은 읽기 전용으로 참조한다.

- `eP_BASES.dbo.dgmast`

## 5. 서버로 전송할 최소 데이터

운영형 API payload는 기존 `/samples`보다 더 좁은 전용 구조가 필요하다.

추천 endpoint:

`POST /api/v1/pharmfarm/agent/prescriptions`

추천 payload:

```json
{
  "agentVersion": "1.0.0",
  "pharmacyId": "issued-by-server",
  "deviceId": "dpapi-protected-device-id",
  "eventId": "sha256(source + prescriptionCode + drugRows)",
  "source": "EPHARM_DB",
  "sourceSchemaVersion": "epharm-prsdrug-v2",
  "syncMode": "LIVE",
  "overwriteExisting": false,
  "resyncRequestId": "",
  "capturedAt": "2026-06-23T00:00:00Z",
  "prescriptionRefHash": "sha256-prescription-code",
  "qrHash": "sha256-qr-if-exists",
  "drugs": [
    {
      "lineNo": 1,
      "insuranceCode": "644304080",
      "drugName": "콜킨정(콜키신)_(0.6mg/1정)",
      "quantityPerDose": 1,
      "dailyFrequency": 1,
      "medicationDays": 30,
      "totalQuantity": 30,
      "substitutionType": 0,
      "substitutionRole": "NONE",
      "pd_extype": 0,
      "pd_exrow": 0,
      "pd_element": ""
    }
  ]
}
```

주의:

- `prescriptionCode` 원문은 가능하면 서버에 보내지 않고 hash만 보낸다.
- `QR 원문`은 운영 기본값에서 보내지 않는다.
- 서버 중복 방지는 `eventId` unique key로 처리한다.
- 약품명은 서버의 DUR 마스터로 재매칭 가능하므로, 에이전트에서 받은 약품명은 보조값으로만 쓴다.
- `pd_extype=1`은 대체 전 원처방으로 보존만 하고 재고 차감 대상에서 제외한다. `pd_extype=2`는 실제 대체 조제 행으로 차감 대상이다.
- 라이브 감시 중 이미 수집한 처방의 `PRESCRIPT_EDB/prsdrug` 스냅샷이 바뀌면 `syncMode=LIVE`, `overwriteExisting=true`로 다시 보내며 서버는 같은 처방 라인을 교체한다.
- 테스트용 금일 재수집은 `syncMode=TODAY_OVERWRITE`, `overwriteExisting=true`, `resyncRequestId`를 보내며 서버는 같은 처방 라인을 upsert/replace한다.

## 6. 네트워크 장애 대응

운영형 에이전트에는 반드시 로컬 큐가 필요하다.

### 6.1 전송 흐름

1. SQL에서 새 처방 이벤트를 감지한다.
2. 전송 payload를 만든다.
3. 먼저 로컬 큐에 `PENDING` 상태로 저장한다.
4. API 전송을 시도한다.
5. 서버가 성공 응답을 주면 해당 큐 항목을 `SENT`로 표시한다.
6. 네트워크 오류, 5xx, timeout이면 큐에 남기고 재시도한다.
7. 400 계열 중 payload 오류는 `DEAD_LETTER`로 분리한다.

### 6.2 재시도 정책

- 최초 실패 후 10초
- 이후 30초, 1분, 5분, 15분, 30분
- 최대 backoff 30분
- 네트워크 복구 시 오래된 항목부터 순차 전송
- 서버가 409 duplicate를 반환하면 성공 처리

### 6.3 큐 보관 정책

- 기본 보관: 7일
- 최대 큐 크기: 예: 10,000건 또는 200MB
- 큐 초과 시 신규 수집은 중단하고 상태 경고 표시
- 전송 완료 항목은 24시간 후 삭제 또는 hash만 남김

## 7. 보안 설계

### 7.1 인증

에이전트는 서버에서 발급한 설치 토큰으로 최초 등록한다.

등록 후:

- `pharmacyId`
- `deviceId`
- `agentSecret`

을 발급받고, 로컬에는 DPAPI로 암호화 저장한다.

API 요청마다 다음을 포함한다.

- `X-PharmFarm-Device-Id`
- `X-PharmFarm-Timestamp`
- `X-PharmFarm-Nonce`
- `X-PharmFarm-Signature`

signature는 `HMAC-SHA256(agentSecret, timestamp + nonce + bodyHash)`로 생성한다.

서버는 다음을 검증한다.

- 등록된 기기인지
- timestamp가 허용 범위 내인지
- nonce 재사용이 아닌지
- HMAC이 일치하는지

### 7.2 전송 보안

- HTTPS만 허용
- API host allowlist 적용
- TLS 인증서 오류 시 전송 중단
- 운영 토큰을 로그에 남기지 않음

### 7.3 로컬 보안

- 설정 파일과 큐 파일은 `%ProgramData%\PharmFarmAgent` 아래 저장
- 파일 ACL은 Administrators, SYSTEM, 현재 사용자 또는 서비스 계정으로 제한
- secret은 DPAPI로 암호화
- raw QR/환자 관련 원문은 기본 저장 금지
- 로그에는 보험코드, 수량 정도만 남기고 처방 코드/QR 원문은 hash 처리

### 7.4 데이터 최소화

운영 기본값:

- QR 원문 전송 안 함
- 처방 코드 원문 전송 안 함
- 환자 직접 식별자 전송 안 함
- DB 스냅샷 기능 제거
- 약품 상세 row 전체 JSON 전송 안 함

디버그 모드는 별도 빌드 또는 서버 발급 단기 토큰으로만 허용한다.

## 8. SQL 조회 안정성

운영형 조회는 좁고 예측 가능해야 한다.

권장:

- `PRESCRIPT_EDB` 최근 N건만 조회
- 늦게 대체 처리된 처방을 잡기 위해 주기적으로 금일 `PRESCRIPT_EDB` 전체를 재스캔
- `prsdrug`는 감지된 처방 코드 기준으로만 조회
- `WITH (NOLOCK)` 유지
- polling interval 기본 10초 이상
- 쿼리 timeout 5~10초
- 실패 시 다음 루프로 넘어감
- 전체 DB/전체 컬럼 scan 금지

중복 감지:

- 로컬 스냅샷 상태: 처방 코드 hash별 `PRESCRIPT_EDB + prsdrug line rows` hash
- payload hash: `prescriptionCode + drug line rows + syncMode`
- 서버 unique key: `pharmacyId + eventId`

## 9. 운영 상태 확인

에이전트는 상태 파일과 서버 heartbeat를 남긴다.

로컬 상태:

- 현재 실행 여부
- 마지막 SQL 연결 성공 시간
- 마지막 API 연결 성공 시간
- 큐 대기 건수
- 마지막 전송 성공 eventId
- 마지막 오류 메시지

서버 heartbeat endpoint:

`POST /api/v1/pharmfarm/agent/heartbeat`

heartbeat payload:

```json
{
  "agentVersion": "1.0.0",
  "pharmacyId": "issued-by-server",
  "deviceId": "device-id",
  "hostNameHash": "hash",
  "lastSqlOkAt": "2026-06-23T00:00:00Z",
  "lastApiOkAt": "2026-06-23T00:00:00Z",
  "pendingQueueCount": 3,
  "status": "OK"
}
```

프론트에는 약국별 에이전트 상태 페이지가 필요하다.

- 온라인/오프라인
- 마지막 수신 시간
- 마지막 오류
- 큐 대기 건수
- 에이전트 버전
- 기기명 또는 설치 별칭

## 10. 설치/운영 방식

초기 운영 버전 설치 방식:

1. 서버 관리자 화면에서 약국용 설치 토큰 생성
2. 약국 PC에 `PharmFarmAgentSetup.exe` 전달
3. 설치 시 설치 토큰 입력
4. 에이전트가 서버에 기기 등록
5. Windows Service로 자동 시작
6. 서버 UI에서 에이전트 온라인 상태 확인

업데이트 방식:

- 1차: 수동 재설치
- 2차: 서명된 업데이트 패키지 다운로드 후 관리자 승인 업데이트

## 11. 서버에서 필요한 작업

운영형 에이전트를 위해 BE에 추가해야 할 항목:

- 에이전트 등록 API
- 에이전트 인증/HMAC 검증
- 처방 약품 전용 수신 API
- eventId unique 처리
- heartbeat 수신 API
- 에이전트 상태 테이블
- 약국/기기별 접근 권한
- 원문 저장 차단 또는 별도 debug flag
- 큐 재전송에 대한 idempotent 응답

필요 테이블 예시:

- `pharmfarm_agent_device`
- `pharmfarm_agent_heartbeat`
- `pharmfarm_agent_event`
- `pharmfarm_prescription`
- `pharmfarm_prescription_drug`

## 12. 프론트에서 필요한 작업

- 처방 목록 페이지
- 처방 상세 페이지
- 약품별 상세 행 표시
- 에이전트 연결 상태 페이지
- 마지막 수신 시간 표시
- 수신 실패/오프라인 경고
- 약국별 기기 별칭 설정

## 13. 단계별 작업 계획

### Phase 1. 현재 PowerShell 안정화

목표:

- 운영에 위험한 모드 숨김
- `04` 중심의 단일 실행 파일로 정리
- raw 원문 저장 줄이기
- interval 기본 10초 이상
- README 운영 절차 정리

산출물:

- `PharmFarm-SqlAgent.ps1` 운영 모드 정리
- `run-pharmfarm-agent.bat`
- 운영용 README

### Phase 2. BE 전용 API 추가

목표:

- `/samples`가 아닌 전용 처방 수집 API로 분리
- 처방 약품 테이블에 직접 적재
- 중복 이벤트 안정 처리

산출물:

- agent prescription endpoint
- heartbeat endpoint
- agent device table
- event unique key

### Phase 3. .NET 운영 에이전트 개발

목표:

- Windows Service 기반 운영형 에이전트
- 로컬 큐
- DPAPI 설정 암호화
- HMAC 인증
- heartbeat
- 로그/상태 파일

산출물:

- `PharmFarm.Agent.exe`
- 설치 스크립트 또는 설치 프로그램
- 설정 파일 템플릿
- 운영 매뉴얼

### Phase 4. 보안/법률 반영

목표:

- 변호사 검토 결과 반영
- 저장 금지 데이터 차단
- 처리위탁/동의/고지 문구 반영

산출물:

- 데이터 수집 범위 확정
- 개인정보 처리 기준 문서
- 운영 로그/보관 정책

## 14. 우선 구현 체크리스트

- [ ] 운영 payload에서 QR 원문 제거
- [ ] 처방 코드 원문 대신 hash 사용
- [ ] 로컬 큐 설계
- [ ] 서버 idempotency key 설계
- [ ] 에이전트 설치 토큰 설계
- [ ] HMAC 인증 방식 추가
- [ ] heartbeat API 추가
- [ ] 에이전트 상태 UI 추가
- [ ] 기존 `/samples` 기반 흐름에서 전용 처방 API로 이전
- [ ] PowerShell 진단 모드와 운영 모드 분리
- [ ] .NET Agent 프로젝트 생성
