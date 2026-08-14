# Bakes init.sql into the image at build time — removes the host bind-mount dependency on an
# absolute worktree path.
FROM pgvector/pgvector:pg16
COPY init.sql /docker-entrypoint-initdb.d/01-extension.sql
