/**
 * KYC Tier Upgrade Admin Routes
 *
 * All routes require admin authentication.
 *
 * GET  /api/admin/kyc-upgrades          — list upgrade requests (filterable by status)
 * POST /api/admin/kyc-upgrades/:id/approve — approve a request (updates kyc_level)
 * POST /api/admin/kyc-upgrades/:id/reject  — reject a request
 */

import { Router, Request, Response } from "express";
import {
  listUpgradeRequests,
  approveKycUpgrade,
  rejectKycUpgrade,
} from "../services/kycTierUpgradeService";

const router = Router();

// ─── list ─────────────────────────────────────────────────────────────────────

router.get("/", async (req: Request, res: Response) => {
  try {
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Math.min(parseInt(String(req.query.limit || "50"), 10), 200);
    const offset = parseInt(String(req.query.offset || "0"), 10);

    const requests = await listUpgradeRequests({ status, limit, offset });
    res.json({ data: requests, count: requests.length });
  } catch (err) {
    console.error("[kyc-upgrades] list error:", err);
    res.status(500).json({ error: "Failed to list KYC upgrade requests" });
  }
});

// ─── approve ──────────────────────────────────────────────────────────────────

router.post("/:id/approve", async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;

    const { userId, newKycLevel } = await approveKycUpgrade({
      requestId,
      reviewedBy,
      notes,
    });

    res.json({
      message: "KYC upgrade approved",
      userId,
      newKycLevel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found")
      ? 404
      : message.includes("terminal state")
        ? 409
        : 500;
    res.status(status).json({ error: message });
  }
});

// ─── reject ───────────────────────────────────────────────────────────────────

router.post("/:id/reject", async (req: Request, res: Response) => {
  try {
    const requestId = req.params.id;
    const reviewedBy: string | undefined =
      (req as any).jwtUser?.userId ?? (req as any).user?.id;

    if (!reviewedBy) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const notes =
      typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined;

    await rejectKycUpgrade({ requestId, reviewedBy, notes });

    res.json({ message: "KYC upgrade rejected" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("not found")
      ? 404
      : message.includes("terminal state")
        ? 409
        : 500;
    res.status(status).json({ error: message });
  }
});

export default router;
