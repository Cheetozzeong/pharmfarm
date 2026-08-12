#!/usr/bin/env python3
"""
Convert KPIS StdCdList.csv into a PharmFarm 1번 기준 데이터 upload CSV.

Default input:
  ~/Downloads/StdCdList/StdCdList.csv

Default output:
  ~/Downloads/StdCdList/pharmfarm_drug_master_import_YYYYMMDD.csv
"""

import argparse
import csv
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path


DEFAULT_SOURCE = Path.home() / "Downloads" / "StdCdList" / "StdCdList.csv"

OUTPUT_HEADERS = [
    "한글상품명",
    "약품규격",
    "제품총수량",
    "표준코드",
    "제품코드(개정후)",
    "전문일반구분",
    "비고",
    "StdCd_적용개시일자",
    "StdCd_적용종료일자",
    "StdCd_양도개시일자",
    "StdCd_양도종료일자",
    "StdCd_상한가",
    "StdCd_급여비급여구분",
    "StdCd_안전상비의약품여부",
    "StdCd_퇴장방지저가방사선여부",
    "StdCd_품목기준코드",
    "StdCd_식약처취소일자",
    "StdCd_일련번호제외여부코드",
    "StdCd_일련번호제외사유코드",
    "StdCd_의약품판독장비구분코드",
]

REQUIRED_UPLOAD_HEADERS = [
    "한글상품명",
    "약품규격",
    "제품총수량",
    "표준코드",
    "제품코드(개정후)",
]

SOURCE_COLUMN_COUNT = 17


@dataclass
class ConvertStats:
    source_rows: int
    output_rows: int
    inactive_rows_skipped: int
    invalid_rows_skipped: int
    duplicate_active_rows_resolved: int
    missing_required_rows: int
    duplicate_standard_code_rows: int
    metadata: list[str] | None


def yyyymmdd(value: str) -> str:
    compact = value.replace("-", "").strip()
    if len(compact) != 8 or not compact.isdigit():
        raise argparse.ArgumentTypeError("date must be YYYYMMDD or YYYY-MM-DD")
    return compact


def default_output_path(source: Path, as_of: str) -> Path:
    return source.parent / f"pharmfarm_drug_master_import_{as_of}.csv"


def derived_product_code(standard_code: str) -> str:
    standard_code = standard_code.strip()
    if len(standard_code) == 13 and standard_code.isdigit():
        return standard_code[3:12]
    return ""


def is_metadata_row(row: list[str]) -> bool:
    return len(row) == 2 and row[1].strip().startswith("수량:")


def is_active(row: list[str], as_of: str) -> bool:
    return row[2].strip() <= as_of <= row[3].strip()


def choose_latest_active_rows(
    rows: list[list[str]], as_of: str
) -> tuple[list[list[str]], int, int, int]:
    chosen: dict[str, tuple[tuple[str, str, int], list[str]]] = {}
    inactive_rows = 0
    invalid_rows = 0

    for index, row in enumerate(rows):
        if len(row) != SOURCE_COLUMN_COUNT:
            invalid_rows += 1
            continue

        standard_code = row[0].strip()
        product_name = row[1].strip()
        product_code = derived_product_code(standard_code)
        if not standard_code or not product_name or not product_code:
            invalid_rows += 1
            continue

        if not is_active(row, as_of):
            inactive_rows += 1
            continue

        score = (row[2].strip(), row[3].strip(), index)
        current = chosen.get(standard_code)
        if current is None or score > current[0]:
            chosen[standard_code] = (score, row)

    selected = [row for _, row in sorted(chosen.values(), key=lambda item: item[0][2])]
    duplicate_active_rows_resolved = len(rows) - inactive_rows - invalid_rows - len(selected)
    return selected, inactive_rows, invalid_rows, duplicate_active_rows_resolved


def output_row(row: list[str]) -> list[str]:
    standard_code = row[0].strip()
    return [
        row[1].strip(),
        "",
        row[6].strip() or "0",
        standard_code,
        derived_product_code(standard_code),
        row[10].strip(),
        "",
        row[2].strip(),
        row[3].strip(),
        row[4].strip(),
        row[5].strip(),
        row[7].strip(),
        row[8].strip(),
        row[9].strip(),
        row[11].strip(),
        row[12].strip(),
        row[13].strip(),
        row[14].strip(),
        row[15].strip(),
        row[16].strip(),
    ]


def validate_output(rows: list[list[str]]) -> tuple[int, int]:
    indexes = {name: index for index, name in enumerate(OUTPUT_HEADERS)}
    missing_headers = [name for name in REQUIRED_UPLOAD_HEADERS if name not in indexes]
    if missing_headers:
        raise RuntimeError(f"internal error: missing output headers: {missing_headers}")

    missing_required_rows = 0
    standard_codes: list[str] = []
    for row in rows:
        name = row[indexes["한글상품명"]].strip()
        standard_code = row[indexes["표준코드"]].strip()
        if not name or not standard_code:
            missing_required_rows += 1
        standard_codes.append(standard_code)

    duplicate_standard_code_rows = sum(
        count for count in Counter(standard_codes).values() if count > 1
    )
    return missing_required_rows, duplicate_standard_code_rows


def convert(source: Path, output: Path, as_of: str) -> ConvertStats:
    if not source.exists():
        raise FileNotFoundError(f"source CSV not found: {source}")

    with source.open("r", encoding="utf-8-sig", newline="") as input_file:
        reader = csv.reader(input_file)
        raw_rows = list(reader)

    metadata = raw_rows[0] if raw_rows and is_metadata_row(raw_rows[0]) else None
    data_rows = raw_rows[1:] if metadata else raw_rows
    selected_rows, inactive_rows, invalid_rows, duplicate_rows = choose_latest_active_rows(
        data_rows, as_of
    )
    output_rows = [output_row(row) for row in selected_rows]
    missing_required_rows, duplicate_standard_code_rows = validate_output(output_rows)

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="") as output_file:
        writer = csv.writer(output_file)
        writer.writerow(OUTPUT_HEADERS)
        writer.writerows(output_rows)

    return ConvertStats(
        source_rows=len(data_rows),
        output_rows=len(output_rows),
        inactive_rows_skipped=inactive_rows,
        invalid_rows_skipped=invalid_rows,
        duplicate_active_rows_resolved=duplicate_rows,
        missing_required_rows=missing_required_rows,
        duplicate_standard_code_rows=duplicate_standard_code_rows,
        metadata=metadata,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert StdCdList.csv into PharmFarm upload-ready 1번 기준 데이터 CSV."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"source StdCdList.csv path (default: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="output CSV path (default: source folder/pharmfarm_drug_master_import_YYYYMMDD.csv)",
    )
    parser.add_argument(
        "--as-of",
        type=yyyymmdd,
        default=date.today().strftime("%Y%m%d"),
        help="active row 기준일, YYYYMMDD or YYYY-MM-DD (default: today)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = args.source.expanduser()
    output = args.output.expanduser() if args.output else default_output_path(source, args.as_of)

    try:
        stats = convert(source, output, args.as_of)
    except Exception as exception:
        print(f"conversion failed: {exception}", file=sys.stderr)
        return 1

    print(f"source={source}")
    if stats.metadata:
        print(f"source_metadata={stats.metadata[0]} / {stats.metadata[1]}")
    print(f"as_of={args.as_of}")
    print(f"output={output}")
    print(f"source_rows={stats.source_rows}")
    print(f"output_rows={stats.output_rows}")
    print(f"inactive_rows_skipped={stats.inactive_rows_skipped}")
    print(f"invalid_rows_skipped={stats.invalid_rows_skipped}")
    print(f"duplicate_active_rows_resolved={stats.duplicate_active_rows_resolved}")
    print(f"missing_required_rows={stats.missing_required_rows}")
    print(f"duplicate_standard_code_rows={stats.duplicate_standard_code_rows}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
