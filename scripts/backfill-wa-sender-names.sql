-- One-time backfill: set sender_name to phone number for WhatsApp messages
-- where pushName was not available at ingestion time.
-- Safe to run multiple times (only updates NULLs).

UPDATE messages
SET sender_name = '+' || split_part(sender_id, '@', 1)
WHERE source = 'whatsapp'
  AND sender_name IS NULL
  AND sender_id IS NOT NULL;
