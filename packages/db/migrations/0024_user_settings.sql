-- 0024 Each back-office user's own settings (W2-07 plan; PLT-13, D-120): for now the theme. A screen preference, like
-- erp.user_login_state: not synced to the counters and not audited, and it never touches erp.users, whose every change
-- is synced and audited. No row means System.
CREATE TABLE erp.user_settings (
  user_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  theme text NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, user_id) REFERENCES erp.users (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.user_settings');
