import AppNotification from "../models/AppNotification";
import Device from "../models/Device";
import logger from "../logger/logger";

function normalizeSourceApp(
  packageName: string,
): "whatsapp" | "gmail" | "unknown" {
  const pkg = String(packageName || "").trim().toLowerCase();

  if (pkg === "com.whatsapp" || pkg === "com.whatsapp.w4b") {
    return "whatsapp";
  }

  if (pkg === "com.google.android.gm") {
    return "gmail";
  }

  return "unknown";
}

/**
 * appNotificationService:
 * saves incoming app notifications from NotificationListener
 * and updates device last-seen timestamp.
 *
 * TTL note:
 * - WhatsApp / WhatsApp Business notifications auto-expire after 2 days
 * - Gmail notifications do not expire automatically
 * - expiresAt is handled by AppNotification model hooks
 */
export async function saveAppNotification(
  deviceId: string,
  payload: {
    packageName: string;
    title?: string;
    text?: string;
    timestamp?: number;
    meta?: Record<string, any>;
  },
) {
  try {
    const ts = payload.timestamp ? Number(payload.timestamp) : Date.now();
    const packageName = String(payload.packageName || "").trim();

    const doc = new AppNotification({
      deviceId: String(deviceId || "").trim(),
      packageName,
      title: String(payload.title || "").trim(),
      text: String(payload.text || "").trim(),
      timestamp: ts,
      sourceApp: normalizeSourceApp(packageName),
      meta: payload.meta || {},
    });

    await doc.save();

    try {
      await Device.findOneAndUpdate(
        { deviceId: String(deviceId || "").trim() },
        {
          $set: {
            "status.timestamp": ts,
          },
        },
        { upsert: true },
      );
    } catch (e) {
      logger.warn("appNotificationService: failed to update device timestamp", e);
    }

    logger.info("appNotificationService: notification saved", {
      deviceId,
      id: doc._id.toString(),
      packageName,
      sourceApp: doc.sourceApp,
      expiresAt: doc.expiresAt || null,
    });

    return doc;
  } catch (err: any) {
    logger.error("appNotificationService: saveAppNotification failed", err);
    throw err;
  }
}

export async function listAppNotifications(filters: {
  deviceId?: string;
  sourceApp?: "whatsapp" | "gmail" | "unknown";
  packageName?: string;
  since?: number;
  limit?: number;
}) {
  try {
    const query: Record<string, any> = {};

    if (filters.deviceId) query.deviceId = String(filters.deviceId).trim();
    if (filters.sourceApp) query.sourceApp = filters.sourceApp;
    if (filters.packageName) query.packageName = String(filters.packageName).trim();

    if (filters.since && Number(filters.since) > 0) {
      query.timestamp = { $gte: Number(filters.since) };
    }

    const limit =
      typeof filters.limit === "number" && filters.limit > 0
        ? Math.min(filters.limit, 1000)
        : 500;

    return await AppNotification.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();
  } catch (err: any) {
    logger.error("appNotificationService: listAppNotifications failed", err);
    throw err;
  }
}

export async function countAppNotifications(filters: {
  deviceId?: string;
  sourceApp?: "whatsapp" | "gmail" | "unknown";
  packageName?: string;
}) {
  try {
    const query: Record<string, any> = {};

    if (filters.deviceId) query.deviceId = String(filters.deviceId).trim();
    if (filters.sourceApp) query.sourceApp = filters.sourceApp;
    if (filters.packageName) query.packageName = String(filters.packageName).trim();

    return await AppNotification.countDocuments(query);
  } catch (err: any) {
    logger.error("appNotificationService: countAppNotifications failed", err);
    throw err;
  }
}

export async function distinctNotificationDevices() {
  try {
    return await AppNotification.distinct("deviceId");
  } catch (err: any) {
    logger.error("appNotificationService: distinctNotificationDevices failed", err);
    throw err;
  }
}

export async function latestNotificationTimestamp(filters: {
  deviceId?: string;
  sourceApp?: "whatsapp" | "gmail" | "unknown";
}) {
  try {
    const query: Record<string, any> = {};

    if (filters.deviceId) query.deviceId = String(filters.deviceId).trim();
    if (filters.sourceApp) query.sourceApp = filters.sourceApp;

    const latest = await AppNotification.findOne(query)
      .sort({ timestamp: -1 })
      .select("timestamp")
      .lean();

    return Number((latest as any)?.timestamp || 0);
  } catch (err: any) {
    logger.error("appNotificationService: latestNotificationTimestamp failed", err);
    throw err;
  }
}

export async function deleteAppNotification(
  deviceId: string,
  notificationId: string,
) {
  try {
    return await AppNotification.findOneAndDelete({
      _id: notificationId,
      deviceId: String(deviceId || "").trim(),
    });
  } catch (err: any) {
    logger.error("appNotificationService: deleteAppNotification failed", err);
    throw err;
  }
}

export async function deleteDeviceAppNotifications(deviceId: string) {
  try {
    return await AppNotification.deleteMany({
      deviceId: String(deviceId || "").trim(),
    });
  } catch (err: any) {
    logger.error("appNotificationService: deleteDeviceAppNotifications failed", err);
    throw err;
  }
}

export async function deleteAllAppNotifications() {
  try {
    return await AppNotification.deleteMany({});
  } catch (err: any) {
    logger.error("appNotificationService: deleteAllAppNotifications failed", err);
    throw err;
  }
}

export async function deleteAppNotificationsOlderThan(cutoff: number) {
  try {
    return await AppNotification.deleteMany({
      timestamp: { $lt: Number(cutoff || 0) },
    });
  } catch (err: any) {
    logger.error("appNotificationService: deleteAppNotificationsOlderThan failed", err);
    throw err;
  }
}