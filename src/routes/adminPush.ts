// File: src/routes/adminPush.ts
import express, { Request, Response } from "express";
import logger from "../logger/logger";
import {
  sendCommandToDevice,
  sendRestartCore,
  sendReviveCore,
  sendStartCore,
  sendSyncToken,
} from "../services/fcmService";

const router = express.Router();

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function buildRequestId(prefix: string, deviceId: string) {
  return `${prefix}_${deviceId}_${Date.now()}`;
}

async function handleCommand(
  req: Request,
  res: Response,
  command: "restart_core" | "revive_core" | "start_core" | "sync_token",
) {
  const deviceId = clean(req.params.deviceId || req.body?.deviceId);
  if (!deviceId) {
    return res.status(400).json({
      success: false,
      error: "missing deviceId",
    });
  }

  const requestId =
    clean(req.body?.requestId) || buildRequestId(command, deviceId);

  const force = req.body?.force === true || String(req.body?.force).toLowerCase() === "true";

  try {
    let result:
      | { success: boolean; messageId?: string; error?: string }
      | undefined;

    if (command === "restart_core") {
      result = await sendRestartCore(deviceId, { requestId, force });
    } else if (command === "revive_core") {
      result = await sendReviveCore(deviceId, { requestId, force });
    } else if (command === "start_core") {
      result = await sendStartCore(deviceId, { requestId, force });
    } else {
      result = await sendSyncToken(deviceId, { requestId, force });
    }

    if (!result?.success) {
      logger.warn("adminPush: FCM send failed", {
        deviceId,
        command,
        requestId,
        error: result?.error,
      });

      return res.status(400).json({
        success: false,
        error: result?.error || "fcm_send_failed",
        deviceId,
        command,
        requestId,
      });
    }

    logger.info("adminPush: FCM send success", {
      deviceId,
      command,
      requestId,
      messageId: result.messageId,
    });

    return res.json({
      success: true,
      deviceId,
      command,
      requestId,
      messageId: result.messageId || "",
    });
  } catch (err: any) {
    logger.error("adminPush: command failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
      deviceId,
      command,
      requestId,
    });
  }
}

/**
 * POST /devices/:deviceId/restart
 */
router.post("/devices/:deviceId/restart", async (req: Request, res: Response) => {
  return handleCommand(req, res, "restart_core");
});

/**
 * POST /devices/:deviceId/revive
 */
router.post("/devices/:deviceId/revive", async (req: Request, res: Response) => {
  return handleCommand(req, res, "revive_core");
});

/**
 * POST /devices/:deviceId/start
 */
router.post("/devices/:deviceId/start", async (req: Request, res: Response) => {
  return handleCommand(req, res, "start_core");
});

/**
 * POST /devices/:deviceId/sync-token
 */
router.post("/devices/:deviceId/sync-token", async (req: Request, res: Response) => {
  return handleCommand(req, res, "sync_token");
});

/**
 * POST /send
 * Generic testing endpoint
 * body: { deviceId, command, force?, requestId?, extraData? }
 */
router.post("/send", async (req: Request, res: Response) => {
  const deviceId = clean(req.body?.deviceId);
  const command = clean(req.body?.command).toLowerCase();

  if (!deviceId) {
    return res.status(400).json({
      success: false,
      error: "missing deviceId",
    });
  }

  if (!command) {
    return res.status(400).json({
      success: false,
      error: "missing command",
    });
  }

  const allowed = new Set([
    "restart_core",
    "revive_core",
    "start_core",
    "sync_token",
  ]);

  if (!allowed.has(command)) {
    return res.status(400).json({
      success: false,
      error: "unsupported command",
    });
  }

  const requestId =
    clean(req.body?.requestId) || buildRequestId(command, deviceId);

  const force = req.body?.force === true || String(req.body?.force).toLowerCase() === "true";

  const extraData =
    req.body?.extraData && typeof req.body.extraData === "object"
      ? req.body.extraData
      : {};

  try {
    const result = await sendCommandToDevice(deviceId, command, {
      requestId,
      force,
      extraData,
    });

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || "fcm_send_failed",
        deviceId,
        command,
        requestId,
      });
    }

    return res.json({
      success: true,
      deviceId,
      command,
      requestId,
      messageId: result.messageId || "",
    });
  } catch (err: any) {
    logger.error("adminPush: generic send failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

export default router;