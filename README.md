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

//
