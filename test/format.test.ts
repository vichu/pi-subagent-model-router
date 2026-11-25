import { expect, test } from "vitest";
import { money, tokens } from "../src/format.ts";

// Shared by the cost dashboard and the routing decisions view; output must stay identical to the dashboard's original helpers.
test("money formats USD with five significant digits and a true minus sign", () => {
  expect([money(undefined), money(11), money(-1), money(0.000123456), money(0)]).toEqual(["unknown", "$11.000", "−$1.0000", "$0.00012346", "$0.0000"]);
});

test("tokens lists the four counters in dashboard order", () => {
  expect(tokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 })).toBe("1 input / 2 output / 3 cache read / 4 cache write");
});
