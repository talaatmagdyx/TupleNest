import { guardReason, coerceParam, paramCount, looksLikeSelect, firstKeyword } from "/Users/talaatmagdyx/work_talaat/TupleNest/apps/desktop/src/lib/sql";
import { analyzeEditability, buildDelete, buildUpdate, buildStatements, coerceValue, previewSql } from "/Users/talaatmagdyx/work_talaat/TupleNest/apps/desktop/src/lib/dml";
import { parseCsv, inferTypes, normalizeHeader, buildInsert, batchRows, coerceCell, CsvStreamParser, QUOTED_EMPTY } from "/Users/talaatmagdyx/work_talaat/TupleNest/apps/desktop/src/lib/csv";
import { tableKey } from "/Users/talaatmagdyx/work_talaat/TupleNest/apps/desktop/src/lib/nodes";

const show = (label: string, v: unknown) => console.log(label.padEnd(64), "=>", JSON.stringify(v));

it("guard matrix (env=prod)", () => {
  const cases = [
    "DELETE FROM users",
    "DELETE FROM users WHERE true",
    "DELETE FROM users WHERE 1=1",
    "UPDATE users SET active=false",
    "UPDATE users SET active=false WHERE id IS NOT NULL",
    "-- cleanup\nDELETE FROM users -- where id=1",
    "/* x */ TRUNCATE users",
    "DROP TABLE users",
    "WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d",
    "WITH d AS (DELETE FROM users WHERE id>0 RETURNING *) SELECT count(*) FROM d",
    "WITH x AS (SELECT 1) INSERT INTO users SELECT * FROM staging",
    "INSERT INTO users SELECT * FROM staging",
    "INSERT INTO users VALUES (1) ON CONFLICT (id) DO UPDATE SET name = 'x'",
    "BEGIN; DROP TABLE users; COMMIT",
    "SELECT 1; DROP TABLE users",
    "SELECT 1; DELETE FROM users",
    "DO $$ BEGIN DELETE FROM users; END $$",
    "CALL purge_all()",
    "SELECT purge_all()",
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
    "SELECT lo_unlink(12345)",
    "SELECT * INTO users_copy FROM users",
    "SELECT setval('users_id_seq', 1)",
    "COPY users FROM PROGRAM 'curl http://x'",
    "COPY users FROM '/tmp/x.csv'",
    "COPY (SELECT * FROM users) TO PROGRAM 'rm -rf /tmp/x'",
    "COPY users TO '/tmp/out.csv'",
    "EXPLAIN ANALYZE DELETE FROM users",
    "EXPLAIN ANALYZE DELETE FROM users WHERE id > 0",
    "EXPLAIN (ANALYZE) UPDATE users SET a=1 WHERE true",
    "VACUUM FULL users",
    "REFRESH MATERIALIZED VIEW mv",
    "MERGE INTO users u USING s ON u.id=s.id WHEN MATCHED THEN DELETE",
    "ALTER TABLE users DROP COLUMN email",
    "CREATE TABLE t AS SELECT 1",
    "COMMENT ON TABLE users IS 'x'",
    "SECURITY LABEL ON TABLE users IS 'x'",
    "LOCK TABLE users IN ACCESS EXCLUSIVE MODE",
    "PREPARE p AS DELETE FROM users",
    "EXECUTE p",
    "SET ROLE postgres",
    "DISCARD ALL",
    "IMPORT FOREIGN SCHEMA s FROM SERVER x INTO public",
    "REASSIGN OWNED BY a TO b",
    "DELETE FROM users WHERE id IN (SELECT id FROM users)",
    "UPDATE users SET \"where\" = 1",
    "UPDATE users SET note = $$ where $$",
    "UPDATE users SET note = E'it\\'s' /* where */",
    "DELETE FROM users USING (SELECT 1 WHERE true) x",
    "UPDATE users SET a = (SELECT 1 WHERE true)",
    "delete from only users",
    "TABLE users",
    "DELETE FROM users WHERE CURRENT OF c",
    "UPDATE users SET a=1 RETURNING (SELECT 1) AS where_",
    "DELETE FROM users\nWHERE",
    "(DELETE FROM users)",
    "ＤＥＬＥＴＥ FROM users",
    "DELETE/**/FROM users WHERE\tfalse OR true",
    "SELECT * FROM users FOR UPDATE",
    "ROLLBACK",
    "COMMIT",
    "SELECT dblink_exec('dbname=x', 'DROP TABLE users')",
    "ANALYZE users",
    "CHECKPOINT",
    "NOTIFY x",
    "DROP DATABASE prod",
  ];
  for (const c of cases) show(c.replace(/\n/g, "\\n"), guardReason(c, "prod")?.verb ?? null);
  show("[env=dev] DROP TABLE users", guardReason("DROP TABLE users", "dev"));
  show("[env=null] DELETE FROM users", guardReason("DELETE FROM users", null));
  show("[env=test] TRUNCATE users", guardReason("TRUNCATE users", "test"));
  show("[env=staging] TRUNCATE users", guardReason("TRUNCATE users", "staging")?.verb);
});

it("params", () => {
  for (const v of ["9007199254740993", "007", "1e5", " 12 ", "null", "NULL", "", "true", "0.1", "12345678901234567890.123456789", "-0", "+5", "  padded text  ", "1.50", ".5", "00501"]) show("coerceParam(" + JSON.stringify(v) + ")", coerceParam(v));
  show("paramCount('select $1, $$ $5 $$')", paramCount("select $1, $$ $5 $$"));
  show("paramCount('select \"a$3\" , $1')", paramCount('select "a$3", $1'));
  show("paramCount('/* $4 */ select $1')", paramCount("/* $4 */ select $1"));
  show("paramCount(\"select E'\\'' , $2\")", paramCount("select E'\\'', $2"));
  show("paramCount('select 1 as a$2')", paramCount("select 1 as a$2"));
});

it("editability + dml", () => {
  const cols = (names: string[]) => names.map((n) => ({ name: n, dbType: "text" }));
  const cat: any = {
    schemas: ["public", "other"], searchPath: ["public"],
    tables: [{ schema: "public", name: "users", kind: "table" }, { schema: "other", name: "users", kind: "table" }, { schema: "public", name: "nopk", kind: "table" }, { schema: "public", name: "ck", kind: "table" }],
    columns: {
      [tableKey("public", "users")]: [
        { name: "id", dbType: "integer", primaryKey: true }, { name: "parent_id", dbType: "integer", primaryKey: false },
        { name: "name", dbType: "character varying(5)", primaryKey: false }, { name: "ts", dbType: "timestamp(3) with time zone", primaryKey: false }, { name: "n", dbType: "numeric(6,2)", primaryKey: false }],
      [tableKey("other", "users")]: [{ name: "id", dbType: "integer", primaryKey: true }, { name: "name", dbType: "text", primaryKey: false }],
      [tableKey("public", "nopk")]: [{ name: "a", dbType: "integer", primaryKey: false }],
      [tableKey("public", "ck")]: [{ name: "a", dbType: "integer", primaryKey: true }, { name: "b", dbType: "integer", primaryKey: true }, { name: "v", dbType: "text", primaryKey: false }],
    },
  };
  const e = (sql: string, c: string[]) => { const r: any = analyzeEditability(sql, cols(c), cat); show(sql, r.editable ? { editable: true, schema: r.target.schema, pk: r.target.pk, writable: r.target.writable } : r.reason); return r; };
  e("select id, name from users", ["id", "name"]);
  const alias = e("select parent_id as id, name from users", ["id", "name"]);
  if (alias.editable) show("  -> delete built for aliased pk row (parent_id=7 shown as id)", buildDelete(alias.target, [7]));
  e("select id + 1 as id, name from users", ["id", "name"]);
  e("select id, upper(name) as name from users", ["id", "name"]);
  e("select id, name from users u", ["id", "name"]);
  e("select id, name from other.users", ["id", "name"]);
  e("select * from nopk", ["a"]);
  e("select a, v from ck", ["a", "v"]);
  e("select a, b, v from ck", ["a", "b", "v"]);
  e("select id, name from users order by name limit 10", ["id", "name"]);
  e("select id, name from users tablesample system (10)", ["id", "name"]);
  e("select id, name from users, generate_series(1,2)", ["id", "name"]);
  e("select id, name from users cross join lateral (select 1) x", ["id", "name"]);
  e("select id, name from only users", ["id", "name"]);
  e("select id, (select name from other.users o where o.id = users.id) as name from users", ["id", "name"]);
  e("select id, name from users where id in (select id from other.users)", ["id", "name"]);
  e("select id, unnest(array[name,name]) as name from users", ["id", "name"]);
  e("select id, name from users for update", ["id", "name"]);
  e("SELECT id, name FROM \"Users\"", ["id", "name"]);
  const t: any = (analyzeEditability("select id, name, ts, n from users", cols(["id", "name", "ts", "n"]), cat) as any).target;
  const up = buildUpdate(t, [1], [{ column: "name", value: "abcdefghij", oldValue: "abc" }]);
  show("buildUpdate varchar(5) <- 'abcdefghij'", up);
  show("buildUpdate ts timestamp(3) with time zone", buildUpdate(t, [1], [{ column: "ts", value: "2024-01-01", oldValue: "2023-01-01T00:00:00Z" }]));
  show("buildUpdate numeric big", buildUpdate(t, ["9007199254740993"], [{ column: "n", value: coerceValue("1234.567", "numeric(6,2)"), oldValue: "1.25" }]));
  show("previewSql", previewSql(up));
  for (const [v, ty] of [["", "text"], ["null", "text"], ["NULL", "character varying"], [" x ", "text"], ["0", "boolean"], ["007", "integer"], ["1e3", "numeric"], ["12.50", "numeric(6,2)"]] as const) show("coerceValue(" + JSON.stringify(v) + "," + ty + ")", coerceValue(v, ty));
});

it("csv", () => {
  const p = (label: string, text: string) => { const t = parseCsv(text); show(label, t); return t; };
  p("blank line in middle", "a,b\n1,2\n\n3,4\n");
  p("trailing blank lines", "a,b\n1,2\n\n\n");
  p("ragged rows", "a,b\n1\n1,2,3\n");
  p("unterminated quote", "a,b\n\"1,2\n3,4\n5,6\n");
  p("text after closing quote", "a,b\n\"x\"y,\"p\" ,2\n");
  p("quote mid-field", "a,b\n5\" disk,x\"y\"\n");
  p("embedded newline + escaped quote", "a,b\n\"l1\r\nl2\",\"say \"\"hi\"\"\"\n");
  p("CR-only line endings", "a,b\r1,2\r3,4\r");
  p("bare CR inside unquoted field", "a,b\nfoo\rbar,2\n");
  p("empty vs quoted empty", "a,b,c\n,\"\",\" \"\n");
  p("BOM", "﻿a,b\n1,2\n");
  p("NUL byte value", "a\n\u0000\n");
  p("space before quote", "a,b\n \"x, y\",2\n");
  const t = parseCsv("zip,phone,amount,flag,big,when,code,sci\n00501,0123456789,1.10,Y,123456789012345678901234567890,2024-01-02 03:04,1e5,1E400\n02134,0987654321,2.00,N,2,2024-01-02 03:04:05,2e3,5\n");
  const types = inferTypes(t);
  show("inferred types", Object.fromEntries(t.header.map((h, i) => [h, types[i]])));
  const cols = t.header.map((h, i) => ({ name: h, type: types[i] }));
  show("insert", buildInsert("public", "t", cols, t.rows.slice(0, 1)));
  show("normalizeHeader dup/long/odd", normalizeHeader(["Name", "name", "NAME ", "", "", "1st", "select", "héllo wörld", "x".repeat(70), "x".repeat(70)]));
  show("batchRows(1..)", [1, 131, 132, 1000, 1600, 70000].map((n) => [n, batchRows(n)]));
  show("coerceCell", [coerceCell("", "text"), coerceCell(QUOTED_EMPTY, "text"), coerceCell(QUOTED_EMPTY, "int8"), coerceCell(" ", "text"), coerceCell(" 5 ", "int8"), coerceCell("NULL", "text"), coerceCell("\\N", "text")]);
  // encoding: how the importer's decoder treats non-UTF-8 input
  const latin1 = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9, 0x0a]); // name\nJos\xe9\n
  const dec = new TextDecoder("utf-8").decode(latin1, { stream: true });
  show("latin1 'José' decoded by TextDecoder('utf-8')", parseCsv(dec));
  const utf16 = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00, 0x0a, 0x00, 0x31, 0x00, 0x2c, 0x00, 0x32, 0x00, 0x0a, 0x00]);
  show("UTF-16LE file decoded as utf-8", parseCsv(new TextDecoder("utf-8").decode(utf16, { stream: true })));
  const sp = new CsvStreamParser(",");
  show("chunk split inside escaped quote", [sp.push('a\n"x"'), sp.push('"y"\n'), sp.end()]);
});
