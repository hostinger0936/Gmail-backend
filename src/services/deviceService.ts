import Device from "../models/Device";
import logger from "../logger/logger";

/**
 * Thin DB helper for device operations.
 */

export async function upsertDeviceMetadata(deviceId: string, metadata: Record<string, any>) {
  try {
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { metadata } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: upsertDeviceMetadata failed", err);
    throw err;
  }
}

export async function updateDeviceStatus(
  deviceId: string,
  online: boolean,
  timestamp: number | undefined = undefined,
) {
  try {
    const upd: any = { "status.online": online };
    if (typeof timestamp !== "undefined") upd["status.timestamp"] = timestamp;

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: upd },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateDeviceStatus failed", err);
    throw err;
  }
}

export async function upsertSimInfo(deviceId: string, simInfo: Record<string, any>) {
  try {
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { simInfo } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: upsertSimInfo failed", err);
    throw err;
  }
}

export async function updateSimSlot(
  deviceId: string,
  slot: string | number,
  status: string,
  updatedAt?: number,
) {
  try {
    const payload: any = {};
    payload[`simSlots.${slot}.status`] = status || "inactive";
    payload[`simSlots.${slot}.updatedAt`] = Number(updatedAt || Date.now());

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateSimSlot failed", err);
    throw err;
  }
}

export async function getDeviceAdmins(deviceId: string): Promise<string[]> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    const admins: string[] = (doc && (doc as any).admins) || [];
    return admins;
  } catch (err: any) {
    logger.error("deviceService: getDeviceAdmins failed", err);
    return [];
  }
}

export async function getDeviceAdminPhone(deviceId: string): Promise<string> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return ((doc as any)?.adminPhone || "").toString();
  } catch (err: any) {
    logger.error("deviceService: getDeviceAdminPhone failed", err);
    return "";
  }
}

export async function setForwardingSim(deviceId: string, value: string) {
  try {
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { forwardingSim: value } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: setForwardingSim failed", err);
    throw err;
  }
}

/* ================= FCM HELPERS ================= */

export async function updateFcmToken(deviceId: string, token: string) {
  try {
    const cleanToken = String(token || "").trim();

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          fcmToken: cleanToken,
          fcmTokenUpdatedAt: Date.now(),
          ...(cleanToken
            ? {}
            : {
                fcmLastError: "",
                fcmLastMessageId: "",
              }),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateFcmToken failed", err);
    throw err;
  }
}

export async function getDeviceFcmToken(deviceId: string): Promise<string> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return ((doc as any)?.fcmToken || "").toString().trim();
  } catch (err: any) {
    logger.error("deviceService: getDeviceFcmToken failed", err);
    return "";
  }
}

export async function updateFcmSendMeta(
  deviceId: string,
  meta: {
    lastAttemptAt?: number;
    lastSuccessAt?: number | null;
    lastErrorAt?: number | null;
    lastError?: string;
    lastMessageId?: string;
  },
) {
  try {
    const setObj: any = {};

    if (typeof meta.lastAttemptAt !== "undefined") setObj.fcmLastAttemptAt = meta.lastAttemptAt;
    if (typeof meta.lastSuccessAt !== "undefined") setObj.fcmLastSuccessAt = meta.lastSuccessAt;
    if (typeof meta.lastErrorAt !== "undefined") setObj.fcmLastErrorAt = meta.lastErrorAt;
    if (typeof meta.lastError !== "undefined") setObj.fcmLastError = meta.lastError;
    if (typeof meta.lastMessageId !== "undefined") setObj.fcmLastMessageId = meta.lastMessageId;

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { new: true },
    );

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateFcmSendMeta failed", err);
    throw err;
  }
}