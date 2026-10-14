import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { registerUsageSidebar, formatSubscriptionRows, formatSubscriptionKeyValues } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
test("multiple enabled subscription windows are labeled, zero and over-limit usage remain accurate", () => {
  assert.deepEqual(formatSubscriptionRows({ subscription: {
    daily_limit_usd: 10, daily_usage_usd: 0,
    weekly_limit_usd: 20, weekly_usage_usd: 20,
    monthly_limit_usd: 30, monthly_usage_usd: 33,
  } }), [{ text: "daily Used      0.0%" }, { text: "daily Time   Unavailable", role: "muted" },
    { text: "weekly Used   100.0%" }, { text: "weekly Time  Unavailable", role: "muted" },
    { text: "monthly Used  110.0%" }, { text: "monthly Time Unavailable", role: "muted" }]);
});

test("disabled limits are omitted and unknown usage is not presented as zero", () => {
  for (const limit of [null, undefined, 0, -1, "10", Infinity, NaN]) {
    assert.deepEqual(formatSubscriptionRows({ subscription: {
      daily_limit_usd: limit, daily_usage_usd: 1, weekly_limit_usd: 10, weekly_usage_usd: 5,
    } }), [{ text: "Used       50.0%" }, { text: "Time     Unavailable", role: "muted" }]);
  }
  for (const used of [null, undefined, -1, "5", Infinity, NaN]) {
    assert.deepEqual(formatSubscriptionRows({ subscription: { weekly_limit_usd: 10, weekly_usage_usd: used } }),
      [{ text: "Used     Unavailable", role: "muted" }, { text: "Time     Unavailable", role: "muted" }]);
  }
});

test("subscription labels and percentage columns align", () => {
  const rows = formatSubscriptionRows({ subscription: {
    daily_limit_usd: 100, daily_usage_usd: 0.01,
    weekly_limit_usd: 100, weekly_usage_usd: 50,
  } });
  assert.deepEqual(rows, [{ text: "daily Used      0.0%" }, { text: "daily Time   Unavailable", role: "muted" },
    { text: "weekly Used    50.0%" }, { text: "weekly Time  Unavailable", role: "muted" }]);
  assert.equal(rows[0].text.length, rows[2].text.length);
});

test("Time represents elapsed weekly allowance, with offset-aware anchors and bounded percentages", () => {
  const now = Date.parse("2026-08-04T12:00:00Z");
  const data = (start) => ({ subscription: { weekly_limit_usd: 400, weekly_usage_usd: 128,
    weekly_window_start: start } });
  assert.deepEqual(formatSubscriptionRows(data("2026-08-01T00:00:00Z"), now),
    [{ text: "Used       32.0%" }, { text: "Time       50.0%" }]);
  assert.equal(formatSubscriptionRows(data("2026-08-01T02:00:00+02:00"), now)[1].text, "Time       50.0%");
  assert.equal(formatSubscriptionRows(data("2026-08-05T00:00:00Z"), now)[1].text, "Time        0.0%");
  assert.equal(formatSubscriptionRows(data("2026-07-01T00:00:00Z"), now)[1].text, "Time      100.0%");
  for (const start of [null, undefined, "invalid", "2026-08-01T00:00:00", 0]) {
    assert.deepEqual(formatSubscriptionRows(data(start), now)[1], { text: "Time     Unavailable", role: "muted" });
  }
});

test("Used colors follow exact thresholds without coloring elapsed Time", () => {
  for (const [percent, role] of [[0, "success"], [49.99, "success"], [50, "caution"],
    [74.99, "caution"], [75, "warning"], [89.99, "warning"], [90, "error"],
    [100, "error"], [110, "error"]]) {
    const rows = formatSubscriptionKeyValues({ subscription: {
      weekly_limit_usd: 100, weekly_usage_usd: percent,
      weekly_window_start: "2026-08-01T00:00:00Z",
    } }, Date.parse("2026-08-04T12:00:00Z"));
    assert.equal(rows[0].valueRole, role);
    assert.deepEqual(rows[1], { label: "Time", value: "50.0%" });
  }
});

const channel = "pi-atelier:sidebar-panels";
function harness(fetchUsage) {
  const handlers = new Map();
  const listeners = new Set();
  const emitted = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    events: {
      on(name, handler) {
        assert.equal(name, channel);
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      emit(name, data) {
        assert.equal(name, channel);
        emitted.push(data);
        for (const handler of listeners) handler(data);
      },
    },
  };
  const usage = registerUsageSidebar(pi, fetchUsage);
  const ctx = { hasUI: true, model: { provider: "sub2api" } };
  return { usage, emitted, listeners, fire: (name, context = ctx) => handlers.get(name)({}, context),
    discover: (data) => pi.events.emit(channel, data), latest: () => emitted.filter(e => e.type === "register").at(-1) };
}

test("panel publishes usage and answers late Atelier discovery with increasing revisions", async () => {
  const h = harness(async () => ({ subscription: { weekly_limit_usd: 400, weekly_usage_usd: 286.86 } }));
  assert.equal(h.emitted.length, 0);
  h.fire("session_start");
  await h.usage.refresh();
  assert.equal(h.latest().panel.id, "sub2api:usage");
  assert.equal(h.latest().panel.title, "Sub2API");
  assert.deepEqual(h.latest().panel.rows, [{ text: "Used       71.7%" }, { text: "Time     Unavailable", role: "muted" }]);
  assert.deepEqual(h.latest().panel.keyValues, [
    { label: "Used", value: "71.7%", valueRole: "caution" },
    { label: "Time", value: "Unavailable", valueRole: "muted" },
  ]);
  const before = h.latest();
  h.discover({ version: 1, type: "discover", requestId: "atelier-1" });
  assert.equal(h.latest().requestId, "atelier-1");
  assert.deepEqual(h.latest().panel.keyValues, before.panel.keyValues);
  assert.ok(h.latest().revision > before.revision);
  assert.equal(h.latest().source, before.source);
  h.discover({ version: 2, type: "discover", requestId: "wrong-version" });
  assert.equal(h.latest().requestId, "atelier-1");
  h.fire("session_shutdown");
  const removal = h.emitted.at(-1);
  assert.equal(removal.type, "unregister");
  assert.equal(removal.id, "sub2api:usage");
  assert.ok(removal.revision > h.latest().revision);
  assert.equal(h.listeners.size, 0);
  h.fire("session_shutdown");
  assert.equal(h.emitted.at(-1), removal);
});

test("startup and command refresh coalesce; only Sub2API agent runs refresh automatically", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { subscription: { weekly_limit_usd: 10, weekly_usage_usd: calls } }; });
  h.fire("session_start");
  await Promise.all([h.usage.refresh(), h.usage.refresh()]);
  assert.equal(calls, 1);
  h.fire("agent_end", { model: { provider: "other" } });
  assert.equal(calls, 1);
  h.fire("agent_end");
  await h.usage.refresh();
  assert.equal(calls, 2);
  assert.deepEqual(h.latest().panel.keyValues, [
    { label: "Used", value: "20.0%", valueRole: "success" },
    { label: "Time", value: "Unavailable", valueRole: "muted" },
  ]);
  assert.deepEqual(h.latest().panel.rows, [{ text: "Used       20.0%" }, { text: "Time     Unavailable", role: "muted" }]);
  h.fire("session_shutdown");
});

test("failures are visible, sensitive errors stay out of panels, and retry succeeds", async () => {
  let fail = true;
  const h = harness(async () => {
    if (fail) throw new Error("secret gateway body");
    return {};
  });
  h.fire("session_start");
  await assert.rejects(h.usage.refresh(), /secret gateway body/);
  assert.deepEqual(h.latest().panel.rows, [{ text: "Usage unavailable - retry /usage", role: "warning" }]);
  assert.equal(h.latest().panel.keyValues, undefined);
  assert.doesNotMatch(JSON.stringify(h.emitted), /secret/);
  fail = false;
  await h.usage.refresh();
  assert.deepEqual(h.latest().panel.rows, [{ text: "No subscription limits available", role: "muted" }]);
  assert.equal(h.latest().panel.keyValues, undefined);
  h.fire("session_shutdown");
});

test("shutdown aborts pending fetch and suppresses late publication", async () => {
  let resolve;
  let signal;
  const h = harness((s) => { signal = s; return new Promise(r => { resolve = r; }); });
  h.fire("session_start");
  const pending = h.usage.refresh();
  await Promise.resolve();
  h.fire("session_shutdown");
  assert.ok(signal.aborted);
  const count = h.emitted.length;
  resolve({ balance: 42 });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.emitted.length, count);
});

test("non-UI startup has no sidebar or automatic network activity; explicit refresh still works", async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { balance: 1 }; });
  h.fire("session_start", { hasUI: false });
  h.fire("agent_end");
  assert.equal(calls, 0);
  assert.equal(h.listeners.size, 0);
  await h.usage.refresh();
  assert.equal(calls, 1);
  assert.equal(h.emitted.length, 0);
});

test("sidebar omits plan names, balance, costs, tokens and model names", async () => {
  const h = harness(async () => ({ planName: "\x1b[31m" + "x".repeat(2000), subscription: { weekly_limit_usd: 400, weekly_usage_usd: 127.88 }, balance: 100,
    usage: { today: { cost: 12.10, requests: 618, total_tokens: 48355390 } },
    model_stats: [{ model: "y".repeat(2000) }] }));
  h.fire("session_start");
  await h.usage.refresh();
  assert.deepEqual(h.latest().panel.rows, [{ text: "Used       32.0%" }, { text: "Time     Unavailable", role: "muted" }]);
  h.fire("session_shutdown");
});
