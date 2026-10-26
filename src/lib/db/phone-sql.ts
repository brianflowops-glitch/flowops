/**
 * SQL mirror of `toE164` (src/lib/phone.ts) applied to a stored phone column, so STOP/START match bookings whose
 * phone was saved as typed ("610-555-0134", "(610) 555-0134", "610 555 0134", "+1 610…", "1-610-…", "… ext 12").
 * Same rules: drop a trailing extension, reject letters, "+…" keeps its digits, 10 digits → +1, 11 starting with 1 → +.
 * (NANP range checks are implied: the value is compared to an already-valid E.164 number.) Stored data is not rewritten.
 *
 * Lives here (not in the server-only webhook store) because the schema uses the same expression for the
 * `booking_phone_e164_idx` expression index (migration 0007). Postgres only uses an expression index when the query's
 * expression is identical, so the index and the STOP/START query must both be built from this one function.
 * Every function used (btrim, regexp_replace, left, length, ~*) is IMMUTABLE, as an index expression requires.
 */
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export function phoneE164Sql(col: SQL | AnyPgColumn) {
  const main = sql`regexp_replace(btrim(${col}), '\\s*(ext\\.?|x)\\s*\\d+$', '', 'i')`;
  const digits = sql`regexp_replace(${main}, '\\D', '', 'g')`;
  return sql`(case
    when ${col} is null or ${main} ~* '[a-z]' then null
    when left(${main}, 1) = '+' then '+' || ${digits}
    when length(${digits}) = 10 then '+1' || ${digits}
    when length(${digits}) = 11 and left(${digits}, 1) = '1' then '+' || ${digits}
    else null end)`;
}
