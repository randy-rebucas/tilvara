-- Hand-written (session 27, ADR-0022): a rescheduled appointment gets a new reminder, so the app
-- clears `reminded_at` when it moves the start (0099 granted it to the worker's pass only).
GRANT UPDATE (reminded_at) ON appointments TO onepos_app;
