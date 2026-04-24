import { Request, Response } from "express";
import { providerBalanceAlertQueue } from "./providerBalanceAlertQueue";
import { accountMergeQueue } from "./accountMergeQueue";
import { getQueueStats } from "./transactionQueue";

export interface QueueDepthMetrics {
  queues: {
    name: string;
    waiting: number;
    active: number;
    depth: number; // waiting + active — the value KEDA scales on
  }[];
  total_depth: number;
  timestamp: string;
}

/**
 * Aggregate queue depth across all BullMQ queues.
 * "depth" = waiting + active jobs — what KEDA uses as the scaling signal.
 */
export async function getQueueDepth(): Promise<QueueDepthMetrics> {
  const [txStats, providerWaiting, providerActive, mergeWaiting, mergeActive] =
    await Promise.all([
      getQueueStats(),
      providerBalanceAlertQueue.getWaitingCount(),
      providerBalanceAlertQueue.getActiveCount(),
      accountMergeQueue.getWaitingCount(),
      accountMergeQueue.getActiveCount(),
    ]);

  const queues = [
    {
      name: "transaction-processing",
      waiting: txStats.waiting,
      active: txStats.active,
      depth: txStats.waiting + txStats.active,
    },
    {
      name: "provider-balance-alerts",
      waiting: providerWaiting,
      active: providerActive,
      depth: providerWaiting + providerActive,
    },
    {
      name: "account-merge",
      waiting: mergeWaiting,
      active: mergeActive,
      depth: mergeWaiting + mergeActive,
    },
  ];

  const total_depth = queues.reduce((sum, q) => sum + q.depth, 0);

  return { queues, total_depth, timestamp: new Date().toISOString() };
}

/**
 * GET /health/queue/depth
 * Returns queue depth as JSON — consumed by KEDA's HTTP external scaler
 * and also useful for dashboards / alerting.
 */
export async function queueDepthHandler(req: Request, res: Response) {
  try {
    const metrics = await getQueueDepth();
    res.json(metrics);
  } catch (err) {
    console.error("Failed to fetch queue depth:", err);
    res.status(500).json({ error: "Failed to fetch queue depth" });
  }
}

/**
 * GET /metrics/queue_depth  (Prometheus text format)
 * Exposes queue_depth gauge so Prometheus + KEDA external metrics adapter
 * can scrape it without a separate exporter.
 */
export async function queueDepthPrometheusHandler(req: Request, res: Response) {
  try {
    const metrics = await getQueueDepth();

    const lines: string[] = [
      "# HELP queue_depth Number of waiting + active jobs in each BullMQ queue",
      "# TYPE queue_depth gauge",
    ];

    for (const q of metrics.queues) {
      lines.push(`queue_depth{queue="${q.name}"} ${q.depth}`);
    }

    lines.push(
      "# HELP queue_depth_total Total pending jobs across all queues",
      "# TYPE queue_depth_total gauge",
      `queue_depth_total ${metrics.total_depth}`,
    );

    res.set("Content-Type", "text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  } catch (err) {
    console.error("Failed to expose queue depth metrics:", err);
    res.status(500).send("# error fetching queue depth\n");
  }
}
