-- 0023 User activity reads the audit log by time (W2-04 plan; RPT-17, PLT-08). The log had an index by record only, so
-- a range of days read the whole table; it grows with every bill line. Newest first, within each tenant.
CREATE INDEX audit_log_at_idx ON erp.audit_log (tenant_id, at DESC);
