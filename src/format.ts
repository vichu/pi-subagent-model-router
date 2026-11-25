import type { RunUsage } from "./history.ts";

export const money = (value: number | undefined) => value === undefined ? "unknown" : `${value < 0 ? "−" : ""}$${Math.abs(value).toPrecision(5)}`;

export const tokens = ({ input, output, cacheRead, cacheWrite }: RunUsage) =>
  `${input} input / ${output} output / ${cacheRead} cache read / ${cacheWrite} cache write`;
