export type PrescriptionChangeLine = {
  lineNo: string;
  insuranceCode: string;
  drugName: string;
  dose: string;
  daily: string;
  days: number;
  quantity: number;
  totalQuantity?: string;
  substitutionType: number;
  substitutionRow?: number;
  element?: string;
};

export type PrescriptionLineChange = {
  key: string;
  kind: "changed" | "added" | "removed";
  before?: PrescriptionChangeLine;
  after?: PrescriptionChangeLine;
  fields: string[];
};

const numeric = (value: unknown) => Number(value ?? 0);
const total = (line: PrescriptionChangeLine) =>
  numeric(line.totalQuantity ?? line.quantity);
const role = (line: PrescriptionChangeLine) =>
  `${line.substitutionType ?? 0}|${line.substitutionRow ?? 0}|${line.element ?? ""}`;

function changedFields(
  before: PrescriptionChangeLine,
  after: PrescriptionChangeLine,
) {
  const fields: string[] = [];
  if (total(before) !== total(after)) fields.push("수량");
  if (
    numeric(before.dose) !== numeric(after.dose) ||
    numeric(before.daily) !== numeric(after.daily) ||
    numeric(before.days) !== numeric(after.days)
  )
    fields.push("복용 정보");
  if (role(before) !== role(after)) fields.push("대체 정보");
  if (before.drugName !== after.drugName) fields.push("약품명");
  return fields;
}

// Match by product, then exact content or row when the same product occurs twice.
// Unrelated products are displayed as removal/addition rather than a quantity change.
export function prescriptionLineChanges(
  before: PrescriptionChangeLine[],
  after: PrescriptionChangeLine[],
  cancellation = false,
): PrescriptionLineChange[] {
  const incoming = cancellation ? [] : after;
  const unused = new Set(before.map((_, index) => index));
  const matches = new Map<number, number>();
  const candidates = (line: PrescriptionChangeLine) =>
    [...unused].filter(
      (index) => before[index].insuranceCode === line.insuranceCode,
    );
  // Reserve unchanged duplicates first, including reordered prescription rows.
  incoming.forEach((line, index) => {
    const exact = candidates(line).find(
      (old) => changedFields(before[old], line).length === 0,
    );
    if (exact !== undefined) {
      matches.set(index, exact);
      unused.delete(exact);
    }
  });
  incoming.forEach((line, index) => {
    if (matches.has(index)) return;
    const same = candidates(line);
    const sameRow = same.find((old) => before[old].lineNo === line.lineNo);
    const unique =
      same.length === 1 &&
      incoming.filter((item) => item.insuranceCode === line.insuranceCode)
        .length === 1;
    const old = sameRow ?? (unique ? same[0] : undefined);
    if (old !== undefined) {
      matches.set(index, old);
      unused.delete(old);
    }
  });
  const changes: PrescriptionLineChange[] = [];
  incoming.forEach((line, index) => {
    const old = matches.get(index);
    if (old === undefined) {
      changes.push({
        key: `added-${index}`,
        kind: "added",
        after: line,
        fields: [],
      });
    } else {
      const fields = changedFields(before[old], line);
      if (fields.length)
        changes.push({
          key: `changed-${old}-${index}`,
          kind: "changed",
          before: before[old],
          after: line,
          fields,
        });
    }
  });
  unused.forEach((index) =>
    changes.push({
      key: `removed-${index}`,
      kind: "removed",
      before: before[index],
      fields: [],
    }),
  );
  return changes;
}

export function prescriptionChangeSummary(
  changes: PrescriptionLineChange[],
  cancellation: boolean,
) {
  if (cancellation) return "처방 취소";
  if (!changes.length) return "처방 정보 변경";
  const labels = { changed: "변경", added: "추가", removed: "삭제" } as const;
  return (["changed", "added", "removed"] as const)
    .map((kind) => {
      const count = changes.filter((change) => change.kind === kind).length;
      return count ? `${labels[kind]} ${count}품목` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

export function prescriptionDecisionReadiness(options: {
  memo: string;
  confirmed: boolean;
  reviewToken?: string;
  canApprove?: boolean;
  saving: boolean;
}) {
  const missing: string[] = [];
  if (!options.memo.trim()) missing.push("처리 사유 입력");
  if (!options.confirmed) missing.push("변경 내용·실제 재고 확인 체크");
  const commonReady =
    !options.saving && missing.length === 0 && Boolean(options.reviewToken);
  return {
    missing,
    canKeep: commonReady,
    canApply: commonReady && options.canApprove === true,
    commonMessage: options.saving
      ? "처리 중입니다. 잠시 기다려 주세요."
      : !options.reviewToken
        ? "검토 정보를 다시 불러와 주세요."
        : missing.length
          ? `${missing.join(" · ")}가 필요합니다.`
          : "필수 확인을 완료했습니다.",
    applyMessage:
      options.canApprove === true
        ? ""
        : "수정 반영은 재고 연결을 복구한 뒤 가능합니다. 기존 처방 유지는 필수 확인 후 선택할 수 있습니다.",
  };
}
