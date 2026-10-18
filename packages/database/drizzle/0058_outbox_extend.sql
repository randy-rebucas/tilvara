-- Hand-written: renew an outbox lease (LEFTOVER, ADR-0016 slice 6). A handler that runs longer than
-- the lease (a large data export) would otherwise be claimed again by another worker and run twice;
-- and in a slow batch, an event further down could have lost its lease before it even started.
-- True only while this worker still holds the event; false tells it to leave the event alone.

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

CREATE FUNCTION outbox_extend(p_id uuid, p_worker text, p_lease_seconds int) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE outbox_events SET locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
     WHERE id = p_id AND status = 'PROCESSING' AND locked_by = p_worker
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

ALTER FUNCTION outbox_extend(uuid, text, int) OWNER TO onepos_platform;
REVOKE ALL ON FUNCTION outbox_extend(uuid, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_extend(uuid, text, int) TO onepos_worker;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
