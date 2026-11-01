/**
 * Test helper: a throwaway SINGLE-NODE REPLICA SET mongod (MongoDB transactions need a replica set) on the default
 * mongoose connection. MONGOD_BIN or `mongod` on PATH; callers skip their suite when mongodBin is empty.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const mongoose = require("mongoose");

const mongodBin = process.env.MONGOD_BIN || (spawnSync("sh", ["-c", "command -v mongod"], { encoding: "utf8" }).stdout || "").trim();
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

async function startReplSet(prefix, dbName) {
  const port = await freePort();
  const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const proc = spawn(mongodBin, ["--replSet", "rs0", "--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  const uri = `mongodb://127.0.0.1:${port}/${dbName}?directConnection=true`;
  for (let i = 0; i < 160 && mongoose.connection.readyState !== 1; i += 1) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); } catch (_) { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (mongoose.connection.readyState !== 1) throw new Error("throwaway mongod did not start");
  const admin = mongoose.connection.db.admin();
  try { await admin.command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } }); } catch (e) { if (!/already initialized/i.test(e.message)) throw e; }
  let primary = false;
  for (let i = 0; i < 240 && !primary; i += 1) {
    primary = (await admin.command({ hello: 1 })).isWritablePrimary === true;
    if (!primary) await new Promise((r) => setTimeout(r, 250));
  }
  if (!primary) throw new Error("throwaway replica set did not elect a primary");
  // reconnect so the driver sees the replica-set topology (the first connection predates replSetInitiate)
  await mongoose.disconnect();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  return {
    uri,
    async stop() {
      await mongoose.disconnect();
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      try { if (dbPath.startsWith(os.tmpdir())) fs.rmSync(dbPath, { recursive: true, force: true }); } catch (_) { /* best-effort temp cleanup */ }
    },
  };
}

module.exports = { mongodBin, startReplSet };
