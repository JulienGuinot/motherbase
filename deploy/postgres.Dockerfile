# postgres:16-alpine has no pg_cron package available (Alpine's apk repos don't
# carry it). Switch to the Debian-based image, which ships the PGDG apt repo
# pg_cron is published on, so a project's db can run pg_cron jobs out of the box
# instead of failing with "extension control file ... No such file or directory".
FROM postgres:16.14-bookworm

# The official postgres bookworm image already writes /etc/apt/sources.list.d/pgdg.list
# (bookworm-pgdg main 16) with its signing key, because it installs Postgres itself
# from PGDG. So no extra repo is added here: pg_cron, pgvector and PostGIS all
# resolve straight from the repo the base image configured.
#
#   postgresql-16-cron        pg_cron, scheduled jobs inside the database
#   postgresql-16-pgvector    vector, embeddings / similarity search (extension name: "vector")
#   postgresql-16-postgis-3   postgis, geospatial types and indexes
#   postgresql-16-pgtap       pgtap, database unit tests (`motherbase test db`); only
#                             ever created inside the test run's rolled-back transaction
#   postgresql-16-hypopg      hypopg, hypothetical indexes (what index_advisor plans against)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-16-cron \
        postgresql-16-pgvector \
        postgresql-16-postgis-3 \
        postgresql-16-pgtap \
        postgresql-16-hypopg \
    && rm -rf /var/lib/apt/lists/*

# pgmq has no PGDG package: apt.postgresql.org carries no pgmq source package for
# any Debian release, and the only prebuilt .deb comes from the third-party Pigsty
# repo. Adding a whole extra apt source for one extension is not worth it, so pgmq
# is built from its own tag instead. It is a pure SQL/plpgsql PGXS extension (no
# Rust, no C, no background worker), so "make install" only copies pgmq.control and
# the versioned SQL files next to the ones apt installed. "make" runs before
# "make install" on purpose: the install file list is a wildcard expanded when the
# makefile is read, and sql/pgmq--<version>.sql only exists after the first pass.
# Build tools are removed in the same layer so they do not stay in the image.
ARG PGMQ_VERSION=v1.12.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates make postgresql-server-dev-16 \
    && git clone --depth 1 --branch "$PGMQ_VERSION" https://github.com/pgmq/pgmq.git /tmp/pgmq \
    && make -C /tmp/pgmq/pgmq-extension \
    && make -C /tmp/pgmq/pgmq-extension install \
    && rm -rf /tmp/pgmq \
    && apt-get purge -y --auto-remove git make postgresql-server-dev-16 \
    && rm -rf /var/lib/apt/lists/*

# Supabase's index_advisor is plain plpgsql over hypopg, with no build step, so
# its control and SQL files are vendored (deploy/postgres/index_advisor, with
# its licence) and copied straight into the extension directory.
# Last, so a change to them never invalidates the pgmq build layer above.
COPY deploy/postgres/index_advisor/index_advisor.control \
     deploy/postgres/index_advisor/index_advisor--0.2.0.sql \
     /usr/share/postgresql/16/extension/
