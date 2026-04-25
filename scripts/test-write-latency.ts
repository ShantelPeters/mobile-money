#!/usr/bin/env ts-node
/**
 * scripts/test-write-latency.ts
 *
 * Measures write latency against the primary and (optionally) the DR replica
 * to quantify the cross-region replication lag and write overhead.
 *
 * Usage:
 *   # Against primary only
 *   DATABASE_URL=postgresql://... npx ts-node scripts/test-write-latency.ts
 *
 *   # Against primary + DR replica (replica must be promoted first)
 *   DATABASE_URL=postgresql://... DR_DATABASE_URL=postgresql://... \
 *     npx ts-node scripts/test-write-latency.ts
 *
 * Options (env vars):
 *   LATENCY_ITERATIONS  Number of write iterations (default: 100)
 *   LATENCY_CONCURRENCY Parallel writers (default: 5)
 */

import { Pool } from "pg";

const ITERATIONS  = parseInt(process.env.LATENCY_ITERATIONS  || "100", 10);
const CONCURRENCY = parseInt(process.env.LATENCY_CONCURRENCY || "5",   10);

interface LatencyResult {
  label:   string;
  p50:     number;
  p95:     number;
  p99:     number;
  mean:    number;
  min:     number;
  max:     number;
  errors:  number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function runLatencyTest(label: string, pool: Pool): Promise<LatencyResult> {
  // Create a temporary table for the test
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _dr_latency_test (
      id      SERIAL PRIMARY KEY,
      payload TEXT,
      ts      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const latencies: number[] = [];
  let errors = 0;

  // Run ITERATIONS writes with CONCURRENCY parallel workers
  const batches = Math.ceil(ITERATIONS / CONCURRENCY);
  for (let b = 0; b < batches; b++) {
    const batchSize = Math.min(CONCURRENCY, ITERATIONS - b * CONCURRENCY);
    await Promise.all(
      Array.from({ length: batchSize }, async (_, i) => {
        const start = process.hrtime.bigint();
        try {
          await pool.query(
            "INSERT INTO _dr_latency_test (payload) VALUES ($1)",
            [`batch-${b}-item-${i}-${Date.now()}`],
          );
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          latencies.push(ms);
        } catch {
          errors++;
        }
      }),
    );
  }

  // Cleanup
  await pool.query("DROP TABLE IF EXISTS _dr_latency_test");

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean   = sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1);

  return {
    label,
    p50:    percentile(sorted, 50),
    p95:    percentile(sorted, 95),
    p99:    percentile(sorted, 99),
    mean:   Math.round(mean * 100) / 100,
    min:    sorted[0]             ?? 0,
    max:    sorted[sorted.length - 1] ?? 0,
    errors,
  };
}

function printResult(r: LatencyResult) {
  console.log(`\n── ${r.label} ──`);
  console.log(`  Iterations : ${ITERATIONS} (concurrency ${CONCURRENCY})`);
  console.log(`  Errors     : ${r.errors}`);
  console.log(`  Mean       : ${r.mean} ms`);
  console.log(`  Min        : ${r.min.toFixed(2)} ms`);
  console.log(`  p50        : ${r.p50.toFixed(2)} ms`);
  console.log(`  p95        : ${r.p95.toFixed(2)} ms`);
  console.log(`  p99        : ${r.p99.toFixed(2)} ms`);
  console.log(`  Max        : ${r.max.toFixed(2)} ms`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is required");
    process.exit(1);
  }

  const primaryPool = new Pool({ connectionString: process.env.DATABASE_URL, max: CONCURRENCY });
  const results: LatencyResult[] = [];

  console.log(`\nWrite latency test — ${ITERATIONS} iterations, concurrency ${CONCURRENCY}`);
  console.log("=".repeat(60));

  results.push(await runLatencyTest("Primary (us-east-1)", primaryPool));
  await primaryPool.end();

  if (process.env.DR_DATABASE_URL) {
    const drPool = new Pool({ connectionString: process.env.DR_DATABASE_URL, max: CONCURRENCY });
    results.push(await runLatencyTest("DR Replica / Promoted (eu-west-1)", drPool));
    await drPool.end();
  }

  results.forEach(printResult);

  if (results.length === 2) {
    const overhead = results[1].mean - results[0].mean;
    console.log(`\n  Cross-region write overhead (mean): ${overhead.toFixed(2)} ms`);
  }

  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
