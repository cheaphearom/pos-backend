-- All times are stored in UTC (reports convert to REPORT_TIMEZONE). If the PostgreSQL server runs in
-- local time (e.g. Asia/Phnom_Penh on a Windows PC or a Docker image with TZ set), database defaults
-- such as created_at and updated_at = now() would be stored 7 hours ahead. Make every new connection
-- to this database use UTC, whatever the server's time zone.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
