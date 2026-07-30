import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { resolveDatabaseUrl } from "../src/lib/resolve-database-url";
import { normalizeLanguage } from "../src/lib/languages";

// One-off backfill that rewrites existing books.language values to canonical
// ISO 639-1 codes (e.g. "English"/"en-GB" -> "en", "Italian"/"it-IT" -> "it").
//
// Dry-run by default — pass --apply to write. Idempotent: re-running after an
// apply reports nothing to change. Values it doesn't recognize are listed and
// left untouched rather than nulled, so no information is silently lost.
//
// NOTE: writing the DB directly does not enqueue a re-organize, so EPUBs that
// are already organized keep their old embedded <dc:language> until their next
// reorganize for some other reason. The DB, API filter, and OPDS feed read from
// the DB and are correct immediately; only the on-disk file bytes lag.

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  console.error(
    "Database config missing: set DATABASE_URL, or POSTGRES_{HOST,USER,PASSWORD,DB} (POSTGRES_PORT defaults to 5432).",
  );
  process.exit(1);
}

const apply = process.argv.includes("--apply");

const redacted = databaseUrl.replace(/\/\/[^@]+@/, "//***@");
console.log(`Language normalization ${apply ? "(APPLY)" : "(dry-run)"} — target: ${redacted}\n`);

const db = drizzle(databaseUrl);

interface Group {
  language: string;
  n: number;
}

try {
  const rows = (await db.execute(
    sql`SELECT language, count(*)::int AS n FROM books WHERE language IS NOT NULL GROUP BY language ORDER BY n DESC`,
  )) as unknown as Group[];

  const planned: { from: string; to: string; n: number }[] = [];
  const unmapped: Group[] = [];
  let alreadyCanonical = 0;

  for (const g of rows) {
    const norm = normalizeLanguage(g.language);
    if (!norm) {
      unmapped.push(g);
    } else if (norm === g.language) {
      alreadyCanonical += g.n;
    } else {
      planned.push({ from: g.language, to: norm, n: g.n });
    }
  }

  const changedRows = planned.reduce((sum, p) => sum + p.n, 0);

  console.log(`Distinct non-null language values: ${rows.length}`);
  console.log(`Already canonical: ${alreadyCanonical} rows\n`);

  if (planned.length > 0) {
    console.log("Will normalize:");
    for (const p of planned) {
      console.log(`  ${JSON.stringify(p.from)} -> ${p.to}  (${p.n} rows)`);
    }
    console.log("");
  }

  if (unmapped.length > 0) {
    console.warn("Unrecognized (left unchanged — fix manually if needed):");
    for (const u of unmapped) {
      console.warn(`  ${JSON.stringify(u.language)}  (${u.n} rows)`);
    }
    console.warn("");
  }

  console.log(`Rows to change: ${changedRows}`);

  if (!apply) {
    console.log("\nDry run — no changes written. Re-run with --apply to write.");
  } else if (planned.length === 0) {
    console.log("\nNothing to change.");
  } else {
    await db.transaction(async (tx) => {
      for (const p of planned) {
        await tx.execute(sql`UPDATE books SET language = ${p.to} WHERE language = ${p.from}`);
      }
    });
    console.log(`\nApplied: ${changedRows} rows updated across ${planned.length} value(s).`);
  }
} finally {
  await db.$client.end();
}
