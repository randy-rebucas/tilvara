-- Audit 2026-10-21 §3 (monitoring): platform_metrics() gains `lodging_stays_nights_overdue`, in-house
-- stays with a night more than a day overdue that the night audit has not charged (alert
-- OneposNightsOverdue, docs/operations/monitoring.md). The rest is 0052's body, unchanged.
CREATE OR REPLACE FUNCTION platform_metrics()
  RETURNS TABLE (metric text, label text, value double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 'outbox_events', s, (SELECT count(*) FROM outbox_events o WHERE o.status = s)::float8
    FROM unnest(ARRAY['PENDING', 'PROCESSING', 'DEAD']) AS s
  UNION ALL
  SELECT 'outbox_oldest_undelivered_age_seconds', '', coalesce(extract(epoch FROM now() - min(o.created_at)), 0)::float8
    FROM outbox_events o WHERE o.status IN ('PENDING', 'PROCESSING')
  UNION ALL
  SELECT 'payment_intents_unresolved', s, (SELECT count(*) FROM payment_intents p WHERE p.status = s)::float8
    FROM unnest(ARRAY['PROCESSING', 'UNKNOWN']) AS s
  UNION ALL
  SELECT 'payment_intents_unresolved_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(p.created_at)), 0)::float8
    FROM payment_intents p WHERE p.status IN ('PROCESSING', 'UNKNOWN')
  UNION ALL
  SELECT 'offline_sales_quarantined', '', count(*)::float8 FROM terminal_transactions x WHERE x.status = 'QUARANTINED'
  UNION ALL
  SELECT 'offline_sales_quarantined_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(x.received_at)), 0)::float8
    FROM terminal_transactions x WHERE x.status = 'QUARANTINED'
  UNION ALL
  -- Same rule as GET /v1/sync/terminals (TILL_SILENCE_MINUTES = 30): a till whose register has an
  -- open shift and that has not been in touch since the later of its last contact and the opening.
  SELECT m, '', v FROM (
    SELECT count(*)::float8 AS open_tills,
           count(*) FILTER (WHERE now() - greatest(c.opened_at, l.contact) > interval '30 minutes')::float8 AS silent,
           coalesce(max(extract(epoch FROM now() - greatest(c.opened_at, l.contact)))
                      FILTER (WHERE now() - greatest(c.opened_at, l.contact) > interval '30 minutes'), 0)::float8 AS longest
      FROM terminals t
      JOIN cashier_sessions c ON c.tenant_id = t.tenant_id AND c.register_id = t.register_id AND c.status = 'OPEN'
      CROSS JOIN LATERAL (
        SELECT greatest(
          (SELECT max(s.as_of) FROM terminal_snapshots s WHERE s.tenant_id = t.tenant_id AND s.terminal_id = t.id),
          (SELECT max(x.received_at) FROM terminal_transactions x WHERE x.tenant_id = t.tenant_id AND x.terminal_id = t.id)) AS contact
      ) l
     WHERE t.revoked_at IS NULL
  ) tills
  CROSS JOIN LATERAL (VALUES ('tills_with_open_shift', tills.open_tills), ('tills_silent', tills.silent),
                             ('tills_longest_silence_seconds', tills.longest)) AS g(m, v)
  UNION ALL
  SELECT 'cashier_sessions_awaiting_approval', '', count(*)::float8 FROM cashier_sessions c WHERE c.status = 'CLOSED'
  UNION ALL
  SELECT 'cashier_sessions_awaiting_approval_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(c.closed_at)), 0)::float8
    FROM cashier_sessions c WHERE c.status = 'CLOSED'
  UNION ALL
  SELECT 'workers_alive', '', count(*) FILTER (WHERE w.beat_at > now() - interval '60 seconds')::float8 FROM worker_heartbeats w
  UNION ALL
  -- No worker has ever beaten (or every one stopped): +Inf, so "older than N" alerts fire.
  SELECT 'worker_heartbeat_age_seconds', '', coalesce(extract(epoch FROM now() - max(w.beat_at))::float8, 'Infinity'::float8)
    FROM worker_heartbeats w
  UNION ALL
  -- Unix time of the last success; 0 when there was none, so "older than N" alerts fire.
  SELECT 'backup_last_success_timestamp_seconds', '', coalesce(extract(epoch FROM max(b.finished_at)), 0)::float8
    FROM backup_runs b WHERE b.kind = 'BACKUP'
  UNION ALL
  SELECT 'restore_drill_last_success_timestamp_seconds', '', coalesce(extract(epoch FROM max(b.finished_at)), 0)::float8
    FROM backup_runs b WHERE b.kind = 'RESTORE_DRILL'
  UNION ALL
  -- In-house stays with a night due more than a day ago (after the branch's night audit time) and not charged.
  SELECT 'lodging_stays_nights_overdue', '', count(*)::float8
    FROM stays s
    JOIN branches b ON b.tenant_id = s.tenant_id AND b.id = s.branch_id
    LEFT JOIN lodging_settings ls ON ls.tenant_id = s.tenant_id AND ls.branch_id = s.branch_id
   WHERE s.status = 'IN_HOUSE'
     AND EXISTS (
       SELECT 1 FROM generate_series(s.arrival_date::timestamp,
                least(s.departure_date - 1, ((now() AT TIME ZONE b.timezone) - coalesce(ls.night_audit_time, time '03:00'))::date - 2)::timestamp,
                interval '1 day') AS d(night)
        WHERE NOT EXISTS (SELECT 1 FROM folio_entries e WHERE e.tenant_id = s.tenant_id AND e.stay_id = s.id AND e.kind = 'ROOM_NIGHT' AND e.night_date = d.night::date))
$$;
--> statement-breakpoint

-- API-key scopes (ADR-0019): the check still listed the first six, so keys with `lodging.read`
-- (ADR-0023 §13), `laundry.read` (ADR-0024 §14) or `appointments.read` (audit 2026-10-21) failed to
-- save. Same list as API_KEY_SCOPES in @1pos/validation.
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;--> statement-breakpoint
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['org.read','catalog.read','sales.read','inventory.read','reports.read','customers.read','lodging.read','laundry.read','appointments.read']::text[]);
