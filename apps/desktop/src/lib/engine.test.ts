import { describe, expect, it } from "vitest";
import {
  ENGINE_CHOICES,
  engineBadge,
  engineName,
  engineOf,
  fileName,
  profileTarget,
  unsupported,
  type Feature,
} from "./engine";

const FEATURES: Feature[] = [
  "monitor",
  "health",
  "partitions",
  "schemaCompare",
  "planCompare",
  "explainAnalyze",
  "csvImport",
  "ssh",
  "tls",
];

describe("engine", () => {
  it("anything but sqlite is PostgreSQL, as every profile before engines", () => {
    expect(engineOf(undefined)).toBe("postgres");
    expect(engineOf(null)).toBe("postgres");
    expect(engineOf("postgres")).toBe("postgres");
    expect(engineOf("sqlite")).toBe("sqlite");
    expect(engineName("sqlite")).toBe("SQLite");
    expect(engineBadge("postgres")).toBe("PG");
    expect(engineBadge("sqlite")).toBe("SQ");
  });

  it("only engines with a driver can be picked", () => {
    const pickable = ENGINE_CHOICES.filter((c) => c.engine).map((c) => c.engine);
    expect(pickable).toEqual(["postgres", "sqlite"]);
    expect(ENGINE_CHOICES.filter((c) => !c.engine).every((c) => c.status !== "available")).toBe(true);
  });

  it("PostgreSQL lacks nothing; SQLite says why for each thing it lacks", () => {
    for (const f of FEATURES) {
      expect(unsupported("postgres", f)).toBeNull();
      expect(unsupported("sqlite", f)).toMatch(/SQLite|file|PostgreSQL/);
    }
  });

  it("names a file by its last part and a profile by its target", () => {
    expect(fileName("/Users/me/data/app.db")).toBe("app.db");
    expect(fileName("C:\\data\\app.db")).toBe("app.db");
    expect(fileName("app.db")).toBe("app.db");
    const pg = { username: "u", host: "h", port: 5432, database: "d" };
    expect(profileTarget(pg)).toBe("u@h:5432/d");
    expect(profileTarget({ ...pg, engine: "sqlite", database: "/x/y.db" })).toBe("/x/y.db");
  });
});
