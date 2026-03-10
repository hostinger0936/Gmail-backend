// File: src/workers/restartCoreWorker.ts
import logger from "../logger/logger";
import Device from "../models/Device";
import wsService from "../services/wsService";
import { sendRestartCore } from "../services/fcmService";

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PER_RUN = 1000; // safety cap

let timer: NodeJS.Timeout | null = null;

function buildRequestId(deviceId: string) {
  return `restart_core_${deviceId}_${Date.now()}`;
}

export function start() {
  logger.info("restartCoreWorker: disabled");
  return;
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  logger.info("restartCoreWorker: stopped");
}

async function run() {
  logger.info("restartCoreWorker: disabled - skipping automatic restart_core run");
  return;

  // old code intentionally left below for future use

  logger.info("restartCoreWorker: run - issuing restart_core to devices");

  try {
    const docs = await Device.find()
      .select("deviceId status.online fcmToken")
      .limit(MAX_PER_RUN)
      .lean();

    if (!docs || docs.length === 0) {
      logger.info("restartCoreWorker: no devices found");
      return;
    }

    let attempted = 0;
    let wsDelivered = 0;
    let fcmDelivered = 0;
    let skippedNoChannel = 0;
    let failed = 0;

    for (const d of docs) {
      const deviceId = String((d as any).deviceId || "").trim();
      if (!deviceId) continue;

      attempted++;

      const requestId = buildRequestId(deviceId);
      const payload = {
        requestId,
        force: true,
        source: "restartCoreWorker",
      };

      try {
        const wsOk = wsService.sendCommandToDevice(deviceId, "restart_core", payload);

        if (wsOk) {
          wsDelivered++;
          logger.info("restartCoreWorker: WS restart_core delivered", {
            deviceId,
            requestId,
          });
          continue;
        }

        const token = String((d as any).fcmToken || "").trim();
        if (!token) {
          skippedNoChannel++;
          logger.warn("restartCoreWorker: skipped, no active WS and no FCM token", {
            deviceId,
            requestId,
          });
          continue;
        }

        const fcmRes = await sendRestartCore(deviceId, {
          requestId,
          force: true,
        });

        if (fcmRes.success) {
          fcmDelivered++;
          logger.info("restartCoreWorker: FCM restart_core delivered", {
            deviceId,
            requestId,
            messageId: fcmRes.messageId,
          });
        } else {
          failed++;
          logger.warn("restartCoreWorker: FCM restart_core failed", {
            deviceId,
            requestId,
            error: fcmRes.error,
          });
        }
      } catch (inner: any) {
        failed++;
        logger.warn("restartCoreWorker: send to device failed", {
          deviceId,
          error: inner?.message || "unknown_error",
        });
      }
    }

    logger.info("restartCoreWorker: completed", {
      attempted,
      wsDelivered,
      fcmDelivered,
      skippedNoChannel,
      failed,
    });
  } catch (err) {
    logger.error("restartCoreWorker: run error", err);
  }
}
