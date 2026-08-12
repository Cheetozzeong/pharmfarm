# PharmFarm Web

약국 재고 스캔, 입고, 반품 공급처 조회 흐름을 확인하기 위한 Vite 기반 웹앱입니다.

## 실행

```bash
pnpm install
pnpm dev
```

## 모바일 래퍼 실행

모바일 앱은 `https://pharmfarm.vercel.app/` 배포본을 WebView로 엽니다.

```bash
pnpm mobile
pnpm mobile:android
pnpm mobile:ios
```

다른 URL로 확인하려면 다음 환경 변수를 사용합니다.

```bash
EXPO_PUBLIC_PHARMFARM_WEB_URL=https://example.com pnpm mobile
```

## 확인

```bash
pnpm build
pnpm format:check
```

## StdCdList 업로드 CSV 변환

매월 받은 `StdCdList.csv`를 서비스의 `1번 기준 데이터` 업로드 형식으로 변환합니다.

```bash
python3 scripts/convert_stdcdlist_for_upload.py
```

기본 입력 파일은 `~/Downloads/StdCdList/StdCdList.csv`이고, 결과는 같은 폴더의 `pharmfarm_drug_master_import_YYYYMMDD.csv`로 생성됩니다.

다른 기준일이나 경로를 쓰려면 다음처럼 실행합니다.

```bash
python3 scripts/convert_stdcdlist_for_upload.py --as-of 2026-08-12 --source ~/Downloads/StdCdList/StdCdList.csv --output ~/Downloads/StdCdList/pharmfarm_drug_master_import_20260812.csv
```
