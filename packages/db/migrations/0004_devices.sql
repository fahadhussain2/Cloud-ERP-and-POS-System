-- 0004 Devices: enrollment codes, key-based device tokens (W0-10; PLT-03; platform spec; D-082).

CREATE TABLE erp.devices (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  -- C01 counters, D01 cash desks, M01 mobile; never reused (prefix of bill numbers, architecture §4.4).
  code text NOT NULL CHECK (code ~ '^[CDM][0-9]{2,}$'),
  name text,
  kind text NOT NULL CHECK (kind IN ('counter', 'cash_desk', 'mobile')),
  -- ECDSA P-256 public key (SPKI DER). The private key never leaves the device.
  public_key bytea NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  enrolled_at timestamptz NOT NULL,
  enrolled_by_user_id uuid,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
SELECT erp.enable_tenant_rls('erp.devices');
SELECT erp.enable_sync('erp.devices');
SELECT erp.enable_audit('erp.devices');
SELECT erp.enable_audit_log('erp.devices');

-- One-time enrollment codes: 15 minutes, single use, only the SHA-256 is stored.
CREATE TABLE erp.device_enrollment_codes (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('counter', 'cash_desk', 'mobile')),
  name text,
  code_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by_device_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES erp.users (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.device_enrollment_codes');

-- Single-use nonces a device signs to get an access token (60 seconds).
CREATE TABLE erp.device_challenges (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  nonce_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.device_challenges');

-- 15-minute device access tokens; only the SHA-256 is stored.
CREATE TABLE erp.device_tokens (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id)
);
CREATE INDEX device_tokens_device_idx ON erp.device_tokens (tenant_id, device_id);
SELECT erp.enable_tenant_rls('erp.device_tokens');
