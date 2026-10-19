import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import "./Toast.css";

type ToastOptions = { tone?: "success" | "error" | "info"; duration?: number };
type ToastMessage = Required<ToastOptions> & { id: number; message: string };
type ShowToast = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const nextId = useRef(0);
  const showToast = useCallback<ShowToast>((message, options = {}) => {
    const tone = options.tone ?? "info";
    setToast({
      id: ++nextId.current,
      message,
      tone,
      duration: options.duration ?? (tone === "error" ? 4500 : 3000),
    });
  }, []);
  const dismiss = useCallback((id: number) => {
    setToast((current) => (current?.id === id ? null : current));
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      {createPortal(
        <div className="app-toast-viewport">
          {toast && <Toast key={toast.id} toast={toast} onDismiss={dismiss} />}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used within ToastProvider");
  return toast;
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: number) => void;
}) {
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    const exitTimer = window.setTimeout(() => setExiting(true), toast.duration);
    const dismissTimer = window.setTimeout(
      () => onDismiss(toast.id),
      toast.duration + 180,
    );
    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(dismissTimer);
    };
  }, [toast.id, toast.duration, onDismiss]);
  const Icon =
    toast.tone === "error"
      ? CircleAlert
      : toast.tone === "success"
        ? CircleCheck
        : Info;

  return (
    <div
      className={`app-toast app-toast--${toast.tone}${exiting ? " is-exiting" : ""}`}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-atomic="true"
    >
      <Icon size={20} aria-hidden="true" />
      <span>{toast.message}</span>
    </div>
  );
}
