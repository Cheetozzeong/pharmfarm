import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

type DiagnosticReport = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("ko-KR")
    : "확인 불가";
}

export function AgentDiagnosticsDialog({
  report,
  loading,
  message,
  onClose,
  onDownload,
}: {
  report: DiagnosticReport | null;
  loading: boolean;
  message: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();

  // Native modal dialogs provide focus trapping, an inert background and
  // focus restoration without adding document-wide keyboard listeners.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      // React removes the dialog before passive cleanup, so restore the
      // original log button explicitly instead of relying on close().
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  const counts = record(report?.counts);
  const runtime = Array.isArray(report?.runtime)
    ? report.runtime.map(record)
    : [];
  const roleLabels: Record<string, string> = {
    agent: "처방 수집 에이전트",
    tray: "트레이 · 재고 경고",
    supervisor: "자동복구",
  };

  return (
    <dialog
      ref={dialogRef}
      className="cms-agent-diagnostic-dialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="cms-agent-diagnostic-dialog-header">
        <div>
          <h2 id={titleId}>진단 로그 결과</h2>
          <span>요청한 시점의 상태 · 환자/처방 원문 제외</span>
        </div>
        <button
          type="button"
          className="cms-agent-diagnostic-close"
          aria-label="진단 로그 닫기"
          autoFocus
          onClick={onClose}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="cms-agent-diagnostic-dialog-body" aria-busy={loading}>
        <p id={messageId} role={report || loading ? "status" : "alert"}>
          {message}
        </p>
        {report && (
          <>
            <dl className="cms-agent-diagnostic-summary">
              {[
                ["전송 대기", counts.queue],
                ["실패 보관", counts["dead-letter"]],
                ["확인 대기 재고 경고", counts["ui-alerts"]],
                ["실패한 재고 경고", counts["ui-alerts-failed"]],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt>{String(label)}</dt>
                  <dd>
                    {typeof value === "number"
                      ? `${count(value)}건`
                      : "확인 불가"}
                  </dd>
                </div>
              ))}
            </dl>
            <section
              className="cms-agent-diagnostic-runtime"
              aria-label="실행 상태"
            >
              <h3>실행 상태</h3>
              {runtime.map((item, index) => (
                <div key={`${String(item.role)}-${index}`}>
                  <strong>
                    {roleLabels[String(item.role)] || "기타 프로세스"}
                  </strong>
                  <span>
                    {item.paused === true
                      ? "일시 정지"
                      : item.running === true
                        ? "실행 중"
                        : "실행 안 됨"}
                  </span>
                  <small>
                    마지막 응답{" "}
                    {typeof item.progressAgeSeconds === "number"
                      ? `${count(item.progressAgeSeconds)}초 전`
                      : "확인 불가"}
                  </small>
                </div>
              ))}
            </section>
            <details className="cms-agent-diagnostic-json">
              <summary>상세 로그 (JSON)</summary>
              <pre tabIndex={0} aria-label="상세 진단 로그 JSON">
                {JSON.stringify(report, null, 2)}
              </pre>
            </details>
          </>
        )}
      </div>
      <footer className="cms-agent-diagnostic-dialog-footer">
        {report && (
          <button type="button" onClick={onDownload}>
            JSON 다운로드
          </button>
        )}
        <button type="button" className="is-primary" onClick={onClose}>
          닫기
        </button>
      </footer>
    </dialog>
  );
}
