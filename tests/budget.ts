/**
 * The time a "stays linear" test allows its input.
 *
 * Each of those tests feeds a hostile input sized so that the quadratic
 * behaviour it guards against takes tens of seconds, and the linear one a few
 * milliseconds. The bound only has to sit between the two. Written next to the
 * milliseconds (100, 200, 500), it also failed on a machine that was merely
 * busy — a laptop running other builds, a shared CI runner — and a red suite
 * that passes when rerun teaches people to rerun. Five seconds is still far
 * under every regression these inputs were built to show.
 */
export const CPU_BUDGET_MS = 5_000;
