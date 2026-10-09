import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
const { outputText } = ts.transpileModule(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { discoverModels } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const fixture = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sub2api-model-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, base: "https://example.invalid", key: "synthetic-test-key", protocol: "auto" };
};
const response = (id) => ({ data: [{ id }] });
const pathFor = (options) => join(options.dir, "sub2api-models", readdirSync(join(options.dir, "sub2api-models"))[0]);

test("cold discovery filters IDs, persists no credentials and uses a short timeout", async (t) => {
  const options = fixture(t);
  const result = await discoverModels({ ...options, fetchModels: async (timeout, signal) => {
    assert.equal(timeout, 2000); assert.equal(signal, undefined);
    return { data: [{ id: "gpt-5" }, { id: "image-model" }, { id: "embedding" }, { id: "gpt-5" }, {}, { id: 42 }] };
  } });
  assert.deepEqual(result.models, [{ id: "gpt-5" }]); assert.equal(result.cached, false);
  assert.ok(!readFileSync(pathFor(options), "utf8").includes(options.key));
});

test("warm startup never fetches; explicit refresh updates next run, failures preserve cache", async (t) => {
  const options = fixture(t);
  await discoverModels({ ...options, fetchModels: async () => response("old") });
  let calls = 0;
  const warm = await discoverModels({ ...options, fetchModels: async () => { calls++; return response("new"); } });
  assert.equal(calls, 0); assert.equal(warm.cached, true); assert.deepEqual(warm.models, [{ id: "old" }]);
  await warm.refresh(); assert.equal(calls, 1);
  for (const fetchModels of [async () => { throw new Error("offline"); }, async () => ({ data: [] })]) {
    const failed = await discoverModels({ ...options, fetchModels });
    await assert.rejects(failed.refresh(), /offline|no usable models/);
    assert.deepEqual(failed.models, [{ id: "new" }]);
  }
});

test("gateway, key and protocol each isolate the cache", async (t) => {
  const options = fixture(t);
  await discoverModels({ ...options, fetchModels: async () => response("original") });
  for (const change of [{ base: "https://other.invalid" }, { key: "different-key" }, { protocol: "openai-responses" }]) {
    let called = false;
    const result = await discoverModels({ ...options, ...change, fetchModels: async () => { called = true; return response("other"); } });
    assert.equal(called, true); assert.equal(result.cached, false);
  }
});

test("corrupt cache is recovered; malformed and empty cold responses fail visibly", async (t) => {
  const options = fixture(t);
  await discoverModels({ ...options, fetchModels: async () => response("old") });
  writeFileSync(pathFor(options), "broken JSON");
  let calls = 0;
  const result = await discoverModels({ ...options, fetchModels: async () => { calls++; return response("new"); } });
  assert.equal(calls, 1); assert.deepEqual(result.models, [{ id: "new" }]);
  for (const data of ["bad", []]) {
    await assert.rejects(discoverModels({ ...options, key: "uncached", fetchModels: async () => ({ data }) }), /model list|no usable models/);
  }
});

test("aborted refresh cannot overwrite cache and receives cancellation signal", async (t) => {
  const options = fixture(t);
  await discoverModels({ ...options, fetchModels: async () => response("old") });
  const controller = new AbortController();
  const warm = await discoverModels({ ...options, fetchModels: async (timeout, signal) => {
    assert.equal(timeout, 8000); assert.equal(signal, controller.signal);
    controller.abort(); return response("obsolete");
  } });
  await assert.rejects(warm.refresh(controller.signal), { name: "AbortError" });
  const next = await discoverModels({ ...options, fetchModels: async () => { throw new Error("unexpected fetch"); } });
  assert.deepEqual(next.models, [{ id: "old" }]);
});
