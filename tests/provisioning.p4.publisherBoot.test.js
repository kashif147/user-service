/**
 * P4 - boot wiring of the provisioning outbox publisher (services/provisioningOutboxBoot.js, bin/user-service.js).
 * Default OFF (no timer without PROVISIONING_OUTBOX_PUBLISHER=on), one timer at most, clean stop / restart, stop on
 * SIGINT / SIGTERM, no implicit dispatch, one-shot publishDueOnce unchanged. No database and no broker: the outbox
 * model and the orchestrator are mocked, the publish function is a stub.
 */
const mockFind = jest.fn();
const mockUpdateOne = jest.fn();
jest.mock("../models/provisioningOutbox.model", () => ({
  find: (...a) => {
    mockFind(...a);
    return { sort: () => ({ limit: () => ({ lean: async () => [] }) }) };
  },
  updateOne: (...a) => mockUpdateOne(...a),
}));
const mockPublishConfirmed = jest.fn(async () => ({ success: true }));
jest.mock("@projectShell/rabbitmq-middleware", () => ({ publisher: { publishConfirmed: (...a) => mockPublishConfirmed(...a) } }));
const mockRequestNextStep = jest.fn();
jest.mock("../services/provisioningOrchestrator", () => ({ requestNextStep: (...a) => mockRequestNextStep(...a) }));

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const ENV_KEYS = ["PROVISIONING_OUTBOX_PUBLISHER", "RABBITMQ_URL", "RABBIT_URL"];
const saved = {};
const fakeProc = () => Object.assign(new EventEmitter(), { pid: 4242, kill: jest.fn() });

let publisher, boot;
beforeEach(() => {
  jest.useFakeTimers();
  jest.isolateModules(() => {
    publisher = require("../services/provisioningOutboxPublisher");
    boot = require("../services/provisioningOutboxBoot");
  });
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  mockFind.mockReset(); mockUpdateOne.mockReset(); mockRequestNextStep.mockReset(); mockPublishConfirmed.mockClear();
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

describe("OFF (default)", () => {
  test.each([undefined, "", "true", "1", "ON", "off"])("PROVISIONING_OUTBOX_PUBLISHER=%p -> no timer, nothing polled, no signal handlers", async (v) => {
    if (v !== undefined) process.env.PROVISIONING_OUTBOX_PUBLISHER = v;
    process.env.RABBITMQ_URL = "amqp://broker.invalid";
    const proc = fakeProc();
    const interval = jest.spyOn(global, "setInterval");
    expect(boot.wireOutboxPublisher({ proc })).toMatchObject({ started: false });
    expect(interval).not.toHaveBeenCalled();
    await tick(60000);
    expect(mockFind).not.toHaveBeenCalled();
    expect(proc.listenerCount("SIGINT") + proc.listenerCount("SIGTERM")).toBe(0);
  });

  test("flag on but no broker URL -> not started (would only burn retry attempts)", async () => {
    process.env.PROVISIONING_OUTBOX_PUBLISHER = "on";
    const interval = jest.spyOn(global, "setInterval");
    expect(boot.wireOutboxPublisher({ proc: fakeProc() })).toEqual({ started: false, reason: "RABBITMQ_URL not set" });
    expect(interval).not.toHaveBeenCalled();
  });
});

describe("ON", () => {
  beforeEach(() => { process.env.PROVISIONING_OUTBOX_PUBLISHER = "on"; process.env.RABBITMQ_URL = "amqp://broker.invalid"; });

  test("exactly one unref'd timer that polls the outbox each interval; never dispatches", async () => {
    const interval = jest.spyOn(global, "setInterval");
    expect(boot.wireOutboxPublisher({ proc: fakeProc() })).toEqual({ started: true });
    expect(interval).toHaveBeenCalledTimes(1);
    expect(interval.mock.calls[0][1]).toBe(5000);
    expect(interval.mock.results[0].value.hasRef()).toBe(false); // never keeps the process alive on its own
    await tick(5000);
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockFind.mock.calls[0][0]).toMatchObject({ status: "pending" });
    await tick(10000);
    expect(mockFind).toHaveBeenCalledTimes(3);
    expect(mockRequestNextStep).not.toHaveBeenCalled(); // drains existing rows only, no implicit dispatch
    expect(mockUpdateOne).not.toHaveBeenCalled(); // nothing due -> nothing leased / marked
    expect(mockPublishConfirmed).not.toHaveBeenCalled();
  });

  test("a second wire call does not create a second timer", async () => {
    const proc = fakeProc();
    const interval = jest.spyOn(global, "setInterval");
    expect(boot.wireOutboxPublisher({ proc })).toEqual({ started: true });
    expect(boot.wireOutboxPublisher({ proc })).toEqual({ started: false, reason: "already started" });
    expect(interval).toHaveBeenCalledTimes(1);
    await tick(5000);
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(proc.listenerCount("SIGINT")).toBe(1);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
  });

  test("restart: stop -> no more polls; start again -> one timer again, signal handlers not duplicated", async () => {
    const proc = fakeProc();
    boot.wireOutboxPublisher({ proc });
    await tick(5000);
    expect(mockFind).toHaveBeenCalledTimes(1);
    publisher.stopOutboxPublisher();
    await tick(30000);
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(boot.wireOutboxPublisher({ proc })).toEqual({ started: true });
    await tick(5000);
    expect(mockFind).toHaveBeenCalledTimes(2);
    expect(proc.listenerCount("SIGINT")).toBe(1);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
  });

  test("SIGTERM stops the timer, then re-raises SIGTERM for the default termination", async () => {
    const proc = fakeProc();
    boot.wireOutboxPublisher({ proc });
    proc.emit("SIGTERM");
    expect(proc.kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    await tick(30000);
    expect(mockFind).not.toHaveBeenCalled();
  });

  test("SIGINT stops the timer, registered ahead of existing SIGINT handlers", async () => {
    const proc = fakeProc();
    const existing = jest.fn(); // e.g. app.js's SIGINT -> process.exit(0)
    proc.on("SIGINT", existing);
    boot.wireOutboxPublisher({ proc });
    expect(proc.listeners("SIGINT")).toHaveLength(2);
    expect(proc.listeners("SIGINT")[1]).toBe(existing); // ours runs first
    proc.emit("SIGINT");
    expect(existing).toHaveBeenCalledTimes(1);
    await tick(30000);
    expect(mockFind).not.toHaveBeenCalled();
  });

  test("a failing tick is logged and does not stop later ticks", async () => {
    mockFind.mockImplementationOnce(() => { throw new Error("db down"); });
    boot.wireOutboxPublisher({ proc: fakeProc() });
    await tick(5000);
    await tick(5000);
    expect(mockFind).toHaveBeenCalledTimes(2);
  });
});

describe("one-shot publishDueOnce unchanged", () => {
  test("works with the flag absent and creates no timer", async () => {
    const interval = jest.spyOn(global, "setInterval");
    const publishFn = jest.fn();
    expect(await publisher.publishDueOnce({ limit: 1, publishFn })).toEqual({ published: 0, retried: 0, dead: 0, skipped: 0 });
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(interval).not.toHaveBeenCalled();
    expect(publishFn).not.toHaveBeenCalled();
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
    expect(src).not.toMatch(/startOutboxPublisher|publishDueOnce|requestNextStep/);
  });
});
