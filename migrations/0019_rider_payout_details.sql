-- 0019: where a rider is paid (an M-Pesa number that may differ from the sign-in number).
ALTER TABLE riders ADD COLUMN payout_phone text NOT NULL DEFAULT '';
ALTER TABLE riders ADD COLUMN payout_name  text NOT NULL DEFAULT '';
