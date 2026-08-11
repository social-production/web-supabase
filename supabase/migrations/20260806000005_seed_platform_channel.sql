-- Seed the special Platform governance channel (FastAPI seed_platform_channel parity).
INSERT INTO channels (slug, name, description, created_by)
VALUES ('platform', 'Platform', 'The platform governance channel', NULL)
ON CONFLICT (slug) DO NOTHING;
