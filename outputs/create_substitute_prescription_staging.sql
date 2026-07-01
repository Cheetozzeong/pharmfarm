SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS __pf_import_stock_movement;
DROP TABLE IF EXISTS __pf_import_prescription_stock_deduction;
DROP TABLE IF EXISTS __pf_import_agent_prescription_line;
DROP TABLE IF EXISTS __pf_import_prescription_drug;
DROP TABLE IF EXISTS __pf_import_prescription;
DROP TABLE IF EXISTS __pf_import_stock;

CREATE TABLE __pf_import_stock LIKE pharmfarm_stock;
CREATE TABLE __pf_import_prescription LIKE pharmfarm_prescription;
CREATE TABLE __pf_import_prescription_drug LIKE pharmfarm_prescription_drug;
CREATE TABLE __pf_import_agent_prescription_line LIKE pharmfarm_agent_prescription_line;
CREATE TABLE __pf_import_prescription_stock_deduction LIKE pharmfarm_prescription_stock_deduction;
CREATE TABLE __pf_import_stock_movement LIKE pharmfarm_stock_movement;

SET FOREIGN_KEY_CHECKS = 1;
