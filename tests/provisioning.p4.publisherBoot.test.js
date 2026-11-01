/**
 * P4 - boot wiring of the provisioning outbox publisher (services/provisioningOutboxBoot.js, bin/user-service.js).
 * Default OFF (no timer without PROVISIONING_OUTBOX_PUBLISHER=on), fail-closed without a broker URL, one timer at most,
 * clean stop / restart, no signal handlers of its own, no implicit dispatch, one-shot publishDueOnce unchanged.
 * In-process tests mock the outbox model, the orchestrator and the middleware (fake timers). The lifecycle tests run
 * the real wiring in a child process (tests/helpers/outboxPublisherChild.js) and send it real SIGTERM / SIGINT.
 */
let mockRows = [];
const mockFind = jest.fn();
const mockUpdateOne = jest.fn(async () => ({ modifiedCount: 1 }));
jest.mock("../models/provisioningOutbox.model", () => ({
  find: (...a) => {
    mockFind(...a);
    return { sort: () => ({ limit: () => ({ lean: async () => mockRows }) }) };
  },
  updateOne: (...a) => mockUpdateOne(...a),
}));
const mockPublishConfirmed = jest.fn(async () => ({ success: true }));
jest.mock("@projectShell/rabbitmq-middleware", () => ({ publisher: { publishConfirmed: (...a) => mockPublishConfirmed(...a) } }));
const mockRequestNextStep = jest.fn();
jest.mock("../services/provisioningOrchestrator", () => ({ requestNextStep: (...a) => mockRequestNextStep(...a) }));

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ENV_KEYS = ["PROVISIONING_OUTBOX_PUBLISHER", "RABBITMQ_URL", "RABBIT_URL"];
const saved = {};
const ROW = { eventId: "prov_row1", tenantId: "t1", eventType: "tenant.provisioning.step.requested.v1", stepKey: "k1", payload: { a: 1 }, publishAttempts: 0 };

describe("in-process", () => {
  let publisher, boot, sigint0, sigterm0;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.isolateModules(() => {
      publisher = require("../services/provisioningOutboxPublisher");
      boot = require("../services/provisioningOutboxBoot");
    });
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    mockRows = [];
    mockFind.mockReset(); mockUpdateOne.mockClear(); mockRequestNextStep.mockReset(); mockPublishConfirmed.mockClear();
    sigint0 = process.listenerCount("SIGINT"); sigterm0 = process.listenerCount("SIGTERM");
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    publisher.stopOutboxPublisher();
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  const tick = async (ms = 5000) => { await jest.advanceTimersByTimeAsync(ms); };
  const noSignalHandlersAdded = () => {
    expect(process.listenerCount("SIGINT")).toBe(sigint0);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm0);
  };

  describe("OFF (default)", () => {
    test.each([undefined, "", "true", "1", "ON", "off"])("PROVISIONING_OUTBOX_PUBLISHER=%p -> no timer, nothing polled or published", async (v) => {
      if (v !== undefined) process.env.PROVISIONING_OUTBOX_PUBLISHER = v;
      process.env.RABBITMQ_URL = "amqp://broker.invalid";
      mockRows = [ROW];
      const interval = jest.spyOn(global, "setInterval");
      expect(boot.wireOutboxPublisher()).toMatchObject({ started: false });
      expect(interval).not.toHaveBeenCalled();
      await tick(60000);
      expect(mockFind).not.toHaveBeenCalled();
      expect(mockPublishConfirmed).not.toHaveBeenCalled();
      noSignalHandlersAdded();
    });

    test("flag on + missing broker configuration -> not started: no timer, no publishing attempt, no URL logged", async () => {
      process.env.PROVISIONING_OUTBOX_PUBLISHER = "on";
      mockRows = [ROW];
      const interval = jest.spyOn(global, "setInterval");
      expect(boot.wireOutboxPublisher()).toEqual({ started: false, reason: "RABBITMQ_URL not set" });
      expect(interval).not.toHaveBeenCalled();
      await tick(60000);
      expect(mockFind).not.toHaveBeenCalled();
      expect(mockPublishConfirmed).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/publisher not started .*no broker URL/));
      expect(JSON.stringify(console.warn.mock.calls)).not.toMatch(/amqp/);
    });
  });

  describe("ON", () => {
    beforeEach(() => { process.env.PROVISIONING_OUTBOX_PUBLISHER = "on"; process.env.RABBITMQ_URL = "amqp://broker.invalid"; });

    test("exactly one unref'd 5 s loop that polls the outbox; never dispatches; adds no signal handlers", async () => {
      const interval = jest.spyOn(global, "setInterval");
      expect(boot.wireOutboxPublisher()).toEqual({ started: true });
      expect(interval).toHaveBeenCalledTimes(1);
      expect(interval.mock.calls[0][1]).toBe(5000);
      expect(interval.mock.results[0].value.hasRef()).toBe(false); // never keeps the process alive on its own
      await tick(5000);
      expect(mockFind).toHaveBeenCalledTimes(1);
      expect(mockFind.mock.calls[0][0]).toMatchObject({ status: "pending" });
      await tick(10000);
      expect(mockFind).toHaveBeenCalledTimes(3);
      expect(mockRequestNextStep).not.toHaveBeenCalled(); // drains existing rows only, no implicit dispatch
      expect(mockPublishConfirmed).not.toHaveBeenCalled(); // nothing due -> nothing published
      noSignalHandlersAdded();
    });

    test("a due row is published by the loop with its own eventId / tenant", async () => {
      mockRows = [ROW];
      boot.wireOutboxPublisher();
      await tick(5000);
      expect(mockPublishConfirmed).toHaveBeenCalledWith(ROW.eventType, ROW.payload, expect.objectContaining({ eventId: ROW.eventId, tenantId: ROW.tenantId }));
      expect(mockRequestNextStep).not.toHaveBeenCalled();
    });

    test("repeated initialisation -> still one loop", async () => {
      const interval = jest.spyOn(global, "setInterval");
      expect(boot.wireOutboxPublisher()).toEqual({ started: true });
      expect(boot.wireOutboxPublisher()).toEqual({ started: false, reason: "already started" });
      expect(boot.wireOutboxPublisher()).toEqual({ started: false, reason: "already started" });
      expect(interval).toHaveBeenCalledTimes(1);
      await tick(5000);
      expect(mockFind).toHaveBeenCalledTimes(1);
    });

    test("stop -> no further tick; restart -> one loop again", async () => {
      const interval = jest.spyOn(global, "setInterval");
      boot.wireOutboxPublisher();
      await tick(5000);
      expect(mockFind).toHaveBeenCalledTimes(1);
      publisher.stopOutboxPublisher();
      await tick(60000);
      expect(mockFind).toHaveBeenCalledTimes(1);
      expect(boot.wireOutboxPublisher()).toEqual({ started: true });
      expect(boot.wireOutboxPublisher()).toEqual({ started: false, reason: "already started" });
      await tick(5000);
      expect(mockFind).toHaveBeenCalledTimes(2);
      expect(interval).toHaveBeenCalledTimes(2);
      noSignalHandlersAdded();
    });

    test("a failing tick is logged and later ticks still run", async () => {
      mockFind.mockImplementationOnce(() => { throw new Error("db down"); });
      boot.wireOutboxPublisher();
      await tick(5000);
      await tick(5000);
      expect(mockFind).toHaveBeenCalledTimes(2);
      expect(console.info).toHaveBeenCalledWith("[provisioning-outbox]", expect.stringContaining("provisioning.outbox.error"));
    });
  });

  describe("one-shot publishDueOnce unchanged", () => {
    test("works independently with the flag absent: publishes the due row, creates no timer", async () => {
      mockRows = [ROW];
      const interval = jest.spyOn(global, "setInterval");
      const publishFn = jest.fn(async () => ({ success: true }));
      expect(await publisher.publishDueOnce({ limit: 1, publishFn })).toEqual({ published: 1, retried: 0, dead: 0, skipped: 0 });
      expect(publishFn).toHaveBeenCalledTimes(1);
      expect(interval).not.toHaveBeenCalled();
      expect(mockRequestNextStep).not.toHaveBeenCalled();
    });
  });
});

describe("bin/user-service.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "bin", "user-service.js"), "utf8");
  test("wires the publisher exactly once, after initEventSystem + setupConsumers, inside the broker try block", () => {
    expect(src.match(/wireOutboxPublisher\(\)/g)).toHaveLength(1);
    const init = src.indexOf("await initEventSystem()");
    const consumers = src.indexOf("await setupConsumers()");
    const wire = src.indexOf("wireOutboxPublisher()");
    const fail = src.indexOf("} catch (err) {");
    expect(init).toBeGreaterThan(-1);
    expect(init < consumers && consumers < wire && wire < fail).toBe(true);
    expect(src).not.toMatch(/startOutboxPublisher|publishDueOnce|requestNextStep|SIGTERM|SIGINT/);
  });
  test("the boot module adds no signal handlers and never sends signals", () => {
    const boot = fs.readFileSync(path.join(__dirname, "..", "services", "provisioningOutboxBoot.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(boot).not.toMatch(/process\.(on|once|prependListener|addListener|kill)\b|SIGTERM|SIGINT/);
  });
});

describe("real process lifecycle (child process, real signals)", () => {
  jest.setTimeout(20000);
  const CHILD = path.join(__dirname, "helpers", "outboxPublisherChild.js");
  const children = [];
  afterEach(() => { for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); }); // a failing test never leaves a child running
  const start = (env) => {
    const child = spawn(process.execPath, [CHILD], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const lines = [];
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; const parts = buf.split("\n"); buf = parts.pop(); lines.push(...parts); });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const waitFor = async (pred, ms = 5000) => {
      const t0 = Date.now();
      while (!pred(lines)) {
        if (Date.now() - t0 > ms) throw new Error(`timeout; lines: ${lines.slice(-5).join(" | ")}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    return { child, lines, exited, waitFor };
  };
  const count = (lines, prefix) => lines.filter((l) => l.startsWith(prefix)).length;
  const ON = { PROVISIONING_OUTBOX_PUBLISHER: "on", RABBITMQ_URL: "amqp://broker.invalid" };
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`did not exit within ${ms} ms`)), ms))]);

  test("SIGTERM: publisher running -> process terminates promptly via the default disposition, no handler of ours", async () => {
    const c = start({ ...ON, CHILD_MODE: "ok" });
    await c.waitFor((l) => count(l, "MARK") >= 3);
    expect(c.lines).toContain('READY {"started":true}');
    expect(c.lines).toContain("SIGNALS SIGINT=1 SIGTERM=0"); // only the app-equivalent SIGINT handler exists
    c.child.kill("SIGTERM");
    expect(await within(c.exited, 3000)).toEqual({ code: null, signal: "SIGTERM" });
  });

  test("SIGINT: the existing shutdown path stays authoritative -> exit 0, nothing published after shutdown begins", async () => {
    const c = start({ ...ON, CHILD_MODE: "ok" });
    await c.waitFor((l) => count(l, "MARK") >= 3);
    c.child.kill("SIGINT");
    expect(await within(c.exited, 3000)).toEqual({ code: 0, signal: null });
    const at = c.lines.indexOf("SHUTDOWN");
    expect(at).toBeGreaterThan(-1);
    expect(c.lines.filter((l) => l === "SHUTDOWN")).toHaveLength(1); // handled once, no loop
    expect(c.lines.slice(at + 1).filter((l) => /^(FIND|PUBLISH|MARK)/.test(l))).toEqual([]);
  });

  test("tick failures do not kill the process; it keeps ticking until signalled", async () => {
    const c = start({ ...ON, CHILD_MODE: "throw" });
    await c.waitFor((l) => count(l, "FIND") >= 5);
    expect(c.child.exitCode).toBeNull();
    expect(c.lines.filter((l) => l.includes("provisioning.outbox.error")).length).toBeGreaterThanOrEqual(4);
    expect(count(c.lines, "PUBLISH")).toBe(0);
    c.child.kill("SIGTERM");
    expect(await within(c.exited, 3000)).toMatchObject({ signal: "SIGTERM" });
  });

  test("repeated initialisation in a real process -> one loop (one FIND per interval)", async () => {
    const c = start({ ...ON, CHILD_MODE: "twice" });
    await c.waitFor((l) => count(l, "FIND") >= 6);
    expect(c.lines.filter((l) => l.startsWith("READY"))).toEqual(['READY {"started":true}', 'READY {"started":false,"reason":"already started"}']);
    // one loop -> FIND / PUBLISH / MARK strictly alternate per row; a second timer would interleave duplicate FINDs
    const seq = c.lines.filter((l) => /^(FIND|MARK)/.test(l)).slice(0, 10).map((l) => l.split(" ")[0]);
    expect(seq).toEqual(["FIND", "MARK", "FIND", "MARK", "FIND", "MARK", "FIND", "MARK", "FIND", "MARK"]);
    c.child.kill("SIGTERM");
    await within(c.exited, 3000);
  });

  test("the timer never keeps a process alive on its own (no HTTP server -> exits by itself)", async () => {
    const c = start({ ...ON, CHILD_MODE: "noserver" });
    expect(await within(c.exited, 3000)).toEqual({ code: 0, signal: null });
    expect(c.lines).toContain('READY {"started":true}');
  });

  test.each([[{}], [{ PROVISIONING_OUTBOX_PUBLISHER: "off", RABBITMQ_URL: "amqp://broker.invalid" }], [{ PROVISIONING_OUTBOX_PUBLISHER: "on" }]])("flag absent / off / on-without-broker %p -> no loop in a real process", async (env) => {
    const c = start({ ...env, CHILD_MODE: "ok" });
    await c.waitFor((l) => l.some((x) => x.startsWith("SIGNALS")));
    await new Promise((r) => setTimeout(r, 400)); // ~8 intervals
    expect(c.lines.find((l) => l.startsWith("READY"))).toMatch(/"started":false/);
    expect(count(c.lines, "FIND") + count(c.lines, "PUBLISH")).toBe(0);
    expect(c.lines.join("\n")).not.toMatch(/amqp:/);
    c.child.kill("SIGTERM");
    await within(c.exited, 3000);
  });
});
