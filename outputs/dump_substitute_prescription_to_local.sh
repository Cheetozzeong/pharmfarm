#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_SQL="$ROOT_DIR/outputs/create_substitute_prescription_staging.sql"
MERGE_SQL="$ROOT_DIR/outputs/merge_substitute_prescription_staging.sql"

: "${PROD_DB_HOST:?set PROD_DB_HOST}"
: "${PROD_DB_USER:?set PROD_DB_USER}"
: "${PROD_DB_NAME:?set PROD_DB_NAME}"
: "${SOURCE_MEMBER_KEY:?set SOURCE_MEMBER_KEY, usually the prod pharmacy id}"
: "${PRESCRIPTION_CODES:?set PRESCRIPTION_CODES, comma-separated prescription codes}"

PROD_DB_PORT="${PROD_DB_PORT:-3306}"
PROD_DB_PASSWORD="${PROD_DB_PASSWORD:-}"

LOCAL_DB_HOST="${LOCAL_DB_HOST:-127.0.0.1}"
LOCAL_DB_PORT="${LOCAL_DB_PORT:-3306}"
LOCAL_DB_USER="${LOCAL_DB_USER:-root}"
LOCAL_DB_PASSWORD="${LOCAL_DB_PASSWORD:-1234}"
LOCAL_DB_NAME="${LOCAL_DB_NAME:-pharmfarm}"

TARGET_MEMBER_KEY="${TARGET_MEMBER_KEY:-2}"
TARGET_ACCOUNT_ID="${TARGET_ACCOUNT_ID:-$TARGET_MEMBER_KEY}"
REPLACE_EXISTING="${REPLACE_EXISTING:-1}"
EXTRA_INSURANCE_CODES="${EXTRA_INSURANCE_CODES:-}"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

sql_quote() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

csv_to_sql_list() {
  local csv="$1"
  local list=""
  local item
  local -a items
  IFS=',' read -r -a items <<< "$csv"
  for item in "${items[@]}"; do
    item="$(trim "$item")"
    if [[ -z "$item" ]]; then
      continue
    fi
    if [[ -n "$list" ]]; then
      list+=", "
    fi
    list+="$(sql_quote "$item")"
  done
  if [[ -z "$list" ]]; then
    echo "PRESCRIPTION_CODES produced an empty SQL list" >&2
    exit 1
  fi
  printf '%s' "$list"
}

prod_args=(-h "$PROD_DB_HOST" -P "$PROD_DB_PORT" -u "$PROD_DB_USER")
if [[ -n "$PROD_DB_PASSWORD" ]]; then
  prod_args+=("--password=$PROD_DB_PASSWORD")
fi

local_args=(-h "$LOCAL_DB_HOST" -P "$LOCAL_DB_PORT" -u "$LOCAL_DB_USER")
if [[ -n "$LOCAL_DB_PASSWORD" ]]; then
  local_args+=("--password=$LOCAL_DB_PASSWORD")
fi
local_args+=("$LOCAL_DB_NAME")

SOURCE_MEMBER_SQL="$(sql_quote "$SOURCE_MEMBER_KEY")"
PRESCRIPTION_CODE_LIST="$(csv_to_sql_list "$PRESCRIPTION_CODES")"

EXTRA_INSURANCE_PREDICATE=""
if [[ -n "$(trim "$EXTRA_INSURANCE_CODES")" ]]; then
  EXTRA_INSURANCE_PREDICATE=" OR insurance_code IN ($(csv_to_sql_list "$EXTRA_INSURANCE_CODES"))"
fi

SOURCE_PRESCRIPTION_IDS="
  SELECT DISTINCT d.prescription_id
  FROM pharmfarm_prescription_stock_deduction d
  WHERE d.member_key = $SOURCE_MEMBER_SQL
    AND d.prescription_code IN ($PRESCRIPTION_CODE_LIST)
    AND d.prescription_id IS NOT NULL
"

SELECTED_DEDUCTIONS="
  SELECT d.id
  FROM pharmfarm_prescription_stock_deduction d
  WHERE d.member_key = $SOURCE_MEMBER_SQL
    AND d.prescription_code IN ($PRESCRIPTION_CODE_LIST)
  UNION
  SELECT shortage.id
  FROM pharmfarm_prescription_stock_deduction shortage
  WHERE shortage.member_key = $SOURCE_MEMBER_SQL
    AND shortage.prescription_code = '대체 약품 부족 수량'
    AND JSON_VALID(shortage.raw_json)
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(shortage.raw_json, '$.sourceDeductionId')) AS UNSIGNED) IN (
      SELECT source_d.id
      FROM pharmfarm_prescription_stock_deduction source_d
      WHERE source_d.member_key = $SOURCE_MEMBER_SQL
        AND source_d.prescription_code IN ($PRESCRIPTION_CODE_LIST)
    )
"

PRESCRIPTION_WHERE="id IN ($SOURCE_PRESCRIPTION_IDS)"
PRESCRIPTION_DRUG_WHERE="prescription_id IN ($SOURCE_PRESCRIPTION_IDS)"
AGENT_LINE_WHERE="pharmacy_id = CAST($SOURCE_MEMBER_SQL AS UNSIGNED) AND prescription_code IN ($PRESCRIPTION_CODE_LIST)"
DEDUCTION_WHERE="id IN ($SELECTED_DEDUCTIONS)"
STOCK_WHERE="
  member_key = $SOURCE_MEMBER_SQL
  AND (
    id IN (
      SELECT stock_id FROM pharmfarm_prescription_stock_deduction WHERE id IN ($SELECTED_DEDUCTIONS) AND stock_id IS NOT NULL
      UNION
      SELECT substitute_stock_id FROM pharmfarm_prescription_stock_deduction WHERE id IN ($SELECTED_DEDUCTIONS) AND substitute_stock_id IS NOT NULL
    )
    OR insurance_code IN (
      SELECT d.insurance_code
      FROM pharmfarm_prescription_drug d
      JOIN pharmfarm_prescription p ON p.id = d.prescription_id
      WHERE p.id IN ($SOURCE_PRESCRIPTION_IDS)
        AND d.insurance_code IS NOT NULL
        AND d.insurance_code <> ''
    )
    $EXTRA_INSURANCE_PREDICATE
  )
"
MOVEMENT_WHERE="
  member_key = $SOURCE_MEMBER_SQL
  AND (
    (reference_type IN ('PRESCRIPTION', 'PRESCRIPTION_OVERWRITE') AND reference_id IN ($PRESCRIPTION_CODE_LIST))
    OR (
      reference_type IN ('PRESCRIPTION_DEDUCTION', 'PRESCRIPTION_SHORTAGE')
      AND reference_id REGEXP '^[0-9]+$'
      AND CAST(reference_id AS UNSIGNED) IN ($SELECTED_DEDUCTIONS)
    )
  )
"

dump_table() {
  local source_table="$1"
  local stage_table="$2"
  local where_clause="$3"

  echo "dumping $source_table -> $stage_table"
  mysqldump \
    "${prod_args[@]}" \
    --no-create-info \
    --skip-triggers \
    --skip-add-locks \
    --skip-disable-keys \
    --single-transaction \
    --quick \
    --compact \
    --complete-insert \
    --set-gtid-purged=OFF \
    "$PROD_DB_NAME" \
    "$source_table" \
    --where="$where_clause" \
    | sed "s/INSERT INTO \`$source_table\`/INSERT INTO \`$stage_table\`/g" \
    | mysql "${local_args[@]}"
}

echo "creating local staging tables in $LOCAL_DB_NAME"
mysql "${local_args[@]}" < "$STAGING_SQL"

dump_table "pharmfarm_stock" "__pf_import_stock" "$STOCK_WHERE"
dump_table "pharmfarm_prescription" "__pf_import_prescription" "$PRESCRIPTION_WHERE"
dump_table "pharmfarm_prescription_drug" "__pf_import_prescription_drug" "$PRESCRIPTION_DRUG_WHERE"
dump_table "pharmfarm_agent_prescription_line" "__pf_import_agent_prescription_line" "$AGENT_LINE_WHERE"
dump_table "pharmfarm_prescription_stock_deduction" "__pf_import_prescription_stock_deduction" "$DEDUCTION_WHERE"
dump_table "pharmfarm_stock_movement" "__pf_import_stock_movement" "$MOVEMENT_WHERE"

echo "merging staging rows into target member_key=$TARGET_MEMBER_KEY"
{
  printf "SET @target_member_key := %s;\n" "$(sql_quote "$TARGET_MEMBER_KEY")"
  printf "SET @source_member_key := %s;\n" "$(sql_quote "$SOURCE_MEMBER_KEY")"
  printf "SET @target_account_id := %s;\n" "$TARGET_ACCOUNT_ID"
  printf "SET @replace_existing := %s;\n" "$REPLACE_EXISTING"
  cat "$MERGE_SQL"
} | mysql "${local_args[@]}"

echo "done"
