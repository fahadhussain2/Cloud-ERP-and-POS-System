-- 0007 Temporary PINs (W1-02; PLT-04; POS spec §5, sync spec §5; D-089): a manager sets a temporary PIN, the
-- person replaces it with their own at a counter.

ALTER TABLE erp.users ADD COLUMN pin_must_change boolean NOT NULL DEFAULT false;

-- Wrong temporary PINs given to a counter's change request; 5 lock the change until a manager sets a new one.
-- Kept with the login bookkeeping, so attempts create no audit or sync noise.
ALTER TABLE erp.user_login_state ADD COLUMN pin_failures smallint NOT NULL DEFAULT 0;
