import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Load the shipped TypeScript without executing the extension factory or reading credentials.
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { formatUsage } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("subscription report shows only enabled windows, including the live weekly allowance", () => {
  const output = formatUsage({
    planName: "open ai 25 % devve",
    subscription: {
      daily_limit_usd: null, daily_usage_usd: 95.7650822,
      weekly_limit_usd: 400, weekly_usage_usd: 286.856287,
      monthly_limit_usd: null, monthly_usage_usd: 286.856287,
    },
  });
  assert.match(output, /plan\s+open ai 25 % devve/);
  assert.match(output, /weekly\s+\$286\.86 \/ \$400\.00 used \| \$113\.14 remaining \(28\.3%\)/);
  assert.doesNotMatch(output, /daily|monthly|reset/i);
});

test("all positive caps display, unused caps remain visible and exhausted caps clamp remaining to zero", () => {
  const output = formatUsage({ subscription: {
    daily_limit_usd: 10, daily_usage_usd: 0,
    weekly_limit_usd: 20, weekly_usage_usd: 20,
    monthly_limit_usd: 30, monthly_usage_usd: 31,
  } });
  assert.match(output, /daily\s+\$0\.00 \/ \$10\.00 used \| \$10\.00 remaining \(100\.0%\)/);
  assert.match(output, /weekly\s+\$20\.00 \/ \$20\.00 used \| \$0\.00 remaining \(0\.0%\)/);
  assert.match(output, /monthly\s+\$31\.00 \/ \$30\.00 used \| \$0\.00 remaining \(0\.0%\)/);
});

test("disabled or malformed subscription limits are not rendered as allowances", () => {
  for (const limit of [null, undefined, 0, -1, "10", Infinity, NaN]) {
    assert.doesNotMatch(formatUsage({ subscription: { weekly_limit_usd: limit, weekly_usage_usd: 0 } }), /weekly/);
  }
  for (const used of [undefined, null, -1, "2", Infinity, NaN]) {
    assert.match(formatUsage({ subscription: { weekly_limit_usd: 10, weekly_usage_usd: used } }), /weekly\s+usage unavailable . \$10\.00 limit/);
  }
});

test("existing balance, usage totals and cost-sorted model display are preserved without a subscription", () => {
  const output = formatUsage({ balance: 5, unit: "USD", usage: { today: { cost: 1, requests: 2, total_tokens: 3 } },
    model_stats: [{ model: "cheap", cost: 1 }, { model: "expensive", cost: 2 }] });
  assert.match(output, /balance\s+5\.00 USD/);
  assert.match(output, /today\s+\$1\.00 . 2 req . 3 tok/);
  assert.ok(output.indexOf("expensive") < output.indexOf("cheap"));
  assert.equal(formatUsage({}), "sub2api usage");
});
