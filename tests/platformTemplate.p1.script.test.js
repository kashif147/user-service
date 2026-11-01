/**
 * Phase B / P1 - scripts/platform-template.js against a REAL throwaway mongod (MONGOD_BIN or `mongod` on PATH;
 * skipped otherwise): dry run by default, explicit --expect-db target, insert-only from the reviewed definition,
 * deterministic hash, never overwrites a published version, retire-only. Audit publish is stubbed.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const mockAudits = [];
jest.mock("../rabbitMQ", () => ({
  initEventSystem: async () => {},
  publishDomainEvent: (...a) => (mockAudits.push(a), Promise.resolve(true)),
}));

const mongoose = require("mongoose");
const { main } = require("../scripts/platform-template");
const PlatformTemplate = require("../models/platformTemplate.model");
const { DEFINITIONS, templateContentHash } = require("../constants/platformTemplates");

jest.setTimeout(60000);
const DEF = DEFINITIONS[0];
const DB = "p1-template-script-test";
const base = ["--key", DEF.key, "--version", String(DEF.version), "--by", "ops-p1", "--approval", "owner-p1"];

const mongodBin = process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const describeDb = mongodBin ? describe : describe.skip;

describeDb("platform-template.js publish / retire", () => {
  let mongod;
  let dbPath;
  let uri;
  let out;
  // Inspect / tamper below the model on the default connection, between script runs (the script connects and
  // disconnects it itself).
  const withDb = async (fn) => {
    await mongoose.connect(uri);
    try {
      return await fn(mongoose.connection.db.collection("platformtemplates"));
    } finally {
      await mongoose.disconnect();
    }
  };
  const docs = () => withDb((c) => c.find({}).toArray());
  beforeAll(async () => {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
      srv.on("error", reject);
    });
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "p1-tpl-script-"));
    mongod = spawn(mongodBin, ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
    uri = `mongodb://127.0.0.1:${port}/${DB}`;
    for (let i = 0; i < 160; i += 1) {
      try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 });
        await mongoose.disconnect();
        break;
      } catch (_) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    process.env.MONGO_URI = uri;
  });
  afterAll(async () => {
    delete process.env.MONGO_URI;
    if (mongod) { const exited = new Promise((r) => mongod.once("exit", r)); mongod.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
    try {
      if (dbPath && dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true });
    } catch (_) {
      // best-effort temp cleanup
    }
  });
  beforeEach(() => {
    out = [];
    mockAudits.length = 0;
    jest.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
  });
  afterEach(() => jest.restoreAllMocks());

  test("no explicit target -> refused before any write; a wrong target -> refused", async () => {
    await expect(main(["publish", ...base, "--execute"])).rejects.toThrow(/--expect-db/);
    await expect(main(["publish", ...base, "--expect-db", "user-service-dev", "--execute"])).rejects.toThrow(/refusing: connected to "p1-template-script-test"/);
    expect(await docs()).toHaveLength(0);
    expect(mockAudits).toHaveLength(0);
  });

  test("dry run by default: prints the plan, writes nothing", async () => {
    await main(["publish", ...base, "--expect-db", DB]);
    expect(out.join("\n")).toMatch(/DRY RUN: nothing written/);
    expect(out.join("\n")).toContain(`contentHash=${templateContentHash(DEF).slice(0, 12)}`);
    expect(await docs()).toHaveLength(0);
  });

  test("--execute publishes exactly the reviewed definition once; a repeat writes nothing; a different hash is refused", async () => {
    await main(["publish", ...base, "--expect-db", DB, "--execute"]);
    let d = await docs();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ key: DEF.key, version: DEF.version, status: "published", contentHash: templateContentHash(DEF), publishedBy: "ops-p1" });
    expect(d[0]).not.toHaveProperty("tenantId");
    expect(mockAudits.map((a) => [a[0], a[1].action, a[1].result, a[2].auditContext.actorScope])).toEqual([["platform.provisioning.template.published.v1", "PLATFORM_TEMPLATE_PUBLISHED", "success", "system"]]);
    const before = JSON.stringify(d);
    await main(["publish", ...base, "--expect-db", DB, "--execute"]);
    expect(out.join("\n")).toMatch(/already published, identical - nothing written/);
    expect(JSON.stringify(await docs())).toBe(before);
    // a stored record that differs from the reviewed definition is never "fixed" by overwriting it
    await withDb((c) => c.updateOne({ key: DEF.key }, { $set: { contentHash: "f".repeat(64) } }));
    await expect(main(["publish", ...base, "--expect-db", DB, "--execute"])).rejects.toThrow(/DIFFERENT contentHash/);
    d = await docs();
    expect(d).toHaveLength(1);
    expect(d[0].contentHash).toBe("f".repeat(64));
  });

  test("retire: dry run by default, then published -> retired only; never deleted", async () => {
    await withDb(async (c) => {
      await expect(PlatformTemplate.deleteMany({})).rejects.toThrow(/never deleted/); // the model refuses deletes
      await c.deleteMany({}); // test reset below the model
    });
    await main(["publish", ...base, "--expect-db", DB, "--execute"]);
    await main(["retire", ...base, "--expect-db", DB]);
    expect((await docs())[0].status).toBe("published");
    await main(["retire", ...base, "--expect-db", DB, "--execute"]);
    const d = await docs();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: "retired", retiredBy: "ops-p1", contentHash: templateContentHash(DEF) });
  });
});

test("definitions command needs no database and prints the deterministic hash", async () => {
  const lines = [];
  jest.spyOn(console, "log").mockImplementation((...a) => lines.push(a.join(" ")));
  await main(["definitions"]);
  expect(lines).toEqual([`${DEF.key} v${DEF.version} contentHash=${templateContentHash(DEF).slice(0, 12)} components=${DEF.components.length}`]);
  jest.restoreAllMocks();
});
