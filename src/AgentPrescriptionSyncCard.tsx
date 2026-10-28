import { useId, useState } from "react";
import {
  prescriptionRangeError,
  prescriptionWeekRange,
} from "./agentPrescriptionRange";
import type { AgentPrescriptionRange } from "./agentPrescriptionRange";

export function AgentPrescriptionSyncCard({
  supported,
  busy,
  onCollect,
}: {
  supported: boolean;
  busy: boolean;
  onCollect: (range: AgentPrescriptionRange) => void;
}) {
  const [range, setRange] = useState(prescriptionWeekRange);
  const descriptionId = useId();
  const error = prescriptionRangeError(range);
  function updateDate(key: keyof AgentPrescriptionRange, value: string) {
    setRange((current) => ({ ...current, [key]: value }));
  }
  return (
    <form
      className="cms-agent-update-card cms-agent-prescription-range"
      onSubmit={(event) => {
        event.preventDefault();
        if (supported && !busy && !error) onCollect(range);
      }}
    >
      <div>
        <strong>기간 지정 처방 수집</strong>
        <p id={descriptionId}>
          선택한 기간의 처방을 다시 반영하고 기존 자동 차감 내역을 보정합니다.
          수동으로 상태를 변경한 처방은 보호됩니다.
        </p>
        <small>
          {supported
            ? "자동 재확인은 이번 주 월요일~일요일 기준입니다. 수동 수집은 한 번에 최대 31일까지 가능합니다."
            : "기간 지정 수집은 에이전트를 1.4.9-ps 이상으로 업데이트한 뒤 사용할 수 있습니다."}
        </small>
        <fieldset
          disabled={!supported || busy}
          aria-describedby={descriptionId}
        >
          <legend>처방 수집 기간</legend>
          <label className="cms-input">
            시작일
            <input
              type="date"
              required
              min="1900-01-01"
              max={range.endDate || "9998-12-31"}
              value={range.startDate}
              onChange={(event) =>
                updateDate("startDate", event.currentTarget.value)
              }
              onInput={(event) =>
                updateDate("startDate", event.currentTarget.value)
              }
            />
          </label>
          <label className="cms-input">
            종료일
            <input
              type="date"
              required
              min={range.startDate || "1900-01-01"}
              max="9998-12-31"
              value={range.endDate}
              onChange={(event) =>
                updateDate("endDate", event.currentTarget.value)
              }
              onInput={(event) =>
                updateDate("endDate", event.currentTarget.value)
              }
            />
          </label>
          <button
            type="button"
            onClick={() => setRange(prescriptionWeekRange())}
          >
            이번 주
          </button>
        </fieldset>
        {error && <small role="status">{error}</small>}
      </div>
      <button type="submit" disabled={!supported || busy || !!error}>
        {busy ? "처리 중" : "지정 기간 수집"}
      </button>
    </form>
  );
}
