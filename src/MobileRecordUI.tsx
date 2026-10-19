import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ClipboardList, X } from "lucide-react";

type Status = "loading" | "done" | "error" | "unauthorized";

export function useOrderRecords<T>(
  load: (signal: AbortSignal) => Promise<T[]>,
  enabled: boolean,
  revision: number,
) {
  const [records, setRecords] = useState<T[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setStatus("loading");
    load(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setRecords(items);
        setStatus("done");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const reason = error instanceof Error ? error.message : "";
        setStatus(reason === "UNAUTHORIZED" ? "unauthorized" : "error");
        setMessage(
          reason === "UNAUTHORIZED"
            ? "로그인이 만료됐습니다. 다시 로그인해 주세요."
            : reason === "FORBIDDEN"
              ? "내역을 조회할 권한이 없습니다. 약국 관리자에게 문의하세요."
              : "내역을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.",
        );
      });
    return () => controller.abort();
  }, [load, enabled, revision]);
  return { records, status, message };
}

export function RecordState({
  status,
  message,
  empty,
  onRetry,
  onLoginRequired,
  children,
}: {
  status: Status;
  message: string;
  empty: string | null;
  onRetry: () => void;
  onLoginRequired: () => void;
  children: ReactNode;
}) {
  if (status === "loading")
    return (
      <div role="status" className="mobile-order-loading">
        <span>내역을 불러오고 있습니다.</span>
        {[1, 2, 3].map((key) => (
          <div key={key} className="mobile-order-skeleton" aria-hidden="true" />
        ))}
      </div>
    );
  if (status !== "done")
    return (
      <div className="empty-state" role="alert">
        <strong>내역을 확인할 수 없습니다</strong>
        <span>{message}</span>
        <button
          className="secondary-btn"
          type="button"
          onClick={status === "unauthorized" ? onLoginRequired : onRetry}
        >
          {status === "unauthorized" ? "다시 로그인" : "다시 불러오기"}
        </button>
      </div>
    );
  if (empty)
    return (
      <div className="empty-state">
        <ClipboardList size={28} aria-hidden="true" />
        <strong>{empty}</strong>
        <span>검색어나 조회 조건을 바꾸어 확인해 주세요.</span>
      </div>
    );
  return <>{children}</>;
}

export function MobileDetailDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="mobile-order-prescription-dialog"
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const r = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button type="button" aria-label={`${title} 닫기`} onClick={onClose}>
          <X size={22} aria-hidden="true" />
        </button>
      </header>
      <div className="mobile-order-prescription-body">{children}</div>
      <footer>
        <button type="button" className="primary-btn" onClick={onClose}>
          목록으로 돌아가기
        </button>
      </footer>
    </dialog>
  );
}
