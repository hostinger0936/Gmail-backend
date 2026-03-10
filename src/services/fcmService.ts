// File: src/services/fcmService.ts
import logger from "../logger/logger";
import Device from "../models/Device";
import { getFirebaseMessaging } from "./firebaseAdmin";

const TAG = "fcmService";

type FcmDataPayload = Record<string, string>;

type SendCommandOptions = {
  requestId?: string;
  force?: boolean;
  extraData?: Record<string, string | number | boolean | null | undefined>;
};

function clean(v: unknown): string {
  return String(v ?? "").trim();
}

function toDataStringMap(
  input: Record<string, string | number | boolean | null | undefined>,
): FcmDataPayload {
  const out: FcmDataPayload = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function isTokenPermanentlyInvalid(err: any): boolean {
  const code = clean(err?.code);
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
}

async function clearBadToken(deviceId: string, reason?: string) {
  try {
    await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          fcmToken: "",
          fcmLastError: reason || "invalid_token",
          fcmLastErrorAt: Date.now(),
        },
      },
    ).exec();

    logger.warn(`${TAG}: cleared invalid FCM token`, { deviceId, reason });
  } catch (e) {
    logger.warn(`${TAG}: failed clearing invalid token`, e);
  }
}

export async function getDeviceFcmToken(deviceId: string): Promise<string> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return clean((doc as any)?.fcmToken);
  } catch (err) {
    logger.error(`${TAG}: getDeviceFcmToken failed`, err);
    return "";
  }
}

export async function saveFcmSendResult(
  deviceId: string,
  success: boolean,
  meta: {
    messageId?: string;
    error?: string;
  } = {},
) {
  try {
    const update: Record<string, unknown> = {
      fcmLastAttemptAt: Date.now(),
    };

    if (success) {
      update.fcmLastSuccessAt = Date.now();
      update.fcmLastMessageId = meta.messageId || "";
      update.fcmLastError = "";
    } else {
      update.fcmLastErrorAt = Date.now();
      update.fcmLastError = meta.error || "send_failed";
    }

    await Device.findOneAndUpdate(
      { deviceId },
      { $set: update },
      { upsert: false },
    ).exec();
  } catch (err) {
    logger.warn(`${TAG}: saveFcmSendResult failed`, err);
  }
}

export function buildCommandPayload(
  deviceId: string,
  command: string,
  options: SendCommandOptions = {},
): FcmDataPayload {
  const base = {
    command,
    deviceId,
    requestId: options.requestId || `${command}_${deviceId}_${Date.now()}`,
    force: options.force === true ? "true" : "false",
    sentAt: Date.now(),
  };

  return {
    ...toDataStringMap(base),
    ...toDataStringMap(options.extraData || {}),
  };
}

export async function sendToToken(
  token: string,
  data: FcmDataPayload,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const cleanToken = clean(token);
  if (!cleanToken) {
    return { success: false, error: "missing_token" };
  }

  try {
    const messaging = getFirebaseMessaging();

    const messageId = await messaging.send({
      token: cleanToken,
      data,
      android: {
        priority: "high",
      },
    });

    return { success: true, messageId };
  } catch (err: any) {
    return {
      success: false,
      error: clean(err?.code || err?.message || "send_failed"),
    };
  }
}

export async function sendToDevice(
  deviceId: string,
  data: FcmDataPayload,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const token = await getDeviceFcmToken(deviceId);

  if (!token) {
    logger.warn(`${TAG}: sendToDevice skipped, token missing`, { deviceId });
    await saveFcmSendResult(deviceId, false, { error: "missing_token" });
    return { success: false, error: "missing_token" };
  }

  const result = await sendToToken(token, data);

  if (result.success) {
    logger.info(`${TAG}: push sent`, {
      deviceId,
      messageId: result.messageId,
      command: data.command,
    });
    await saveFcmSendResult(deviceId, true, { messageId: result.messageId });
    return result;
  }

  logger.warn(`${TAG}: push failed`, {
    deviceId,
    error: result.error,
    command: data.command,
  });

  await saveFcmSendResult(deviceId, false, { error: result.error });

  if (isTokenPermanentlyInvalid({ code: result.error })) {
    await clearBadToken(deviceId, result.error);
  }

  return result;
}

export async function sendCommandToDevice(
  deviceId: string,
  command: string,
  options: SendCommandOptions = {},
) {
  const payload = buildCommandPayload(deviceId, command, options);
  return sendToDevice(deviceId, payload);
}

export async function sendRestartCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "restart_core", options);
}

export async function sendReviveCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "revive_core", options);
}

export async function sendStartCore(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "start_core", options);
}

export async function sendSyncToken(
  deviceId: string,
  options: Omit<SendCommandOptions, "extraData"> = {},
) {
  return sendCommandToDevice(deviceId, "sync_token", options);
}

export default {
  getDeviceFcmToken,
  buildCommandPayload,
  sendToToken,
  sendToDevice,
  sendCommandToDevice,
  sendRestartCore,
  sendReviveCore,
  sendStartCore,
  sendSyncToken,
};