# index_advisor (vendored)

Supabase's `index_advisor` extension, copied unmodified from
https://github.com/supabase/index_advisor at tag `v0.2.0`
(commit `d37723555e6425f18e6a45cb0956ced2250a3fe7`). PostgreSQL License, see
`LICENSE` (Copyright (c) 2023, Supabase).

It is pure plpgsql on top of `hypopg`, so the Postgres image installs `hypopg`
from PGDG and copies these two files into the extension directory instead of
cloning and building anything. To upgrade, replace both files with a newer
release's `index_advisor.control` and `index_advisor--<version>.sql`.
