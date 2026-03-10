/**
 * heartbeatWorker.ts
 *
 * Purpose:
 * - Mark devices OFFLINE if they stop sending heartbeat.
 * - Prevent stuck-online state.
 *
 * Logic:
 * - Device sends WS status heartbeat (online=true)
 * - If heartbeat not received within threshold -> OFFLINE
 * - If there's an active WS connection for the device, skip
 * - WS disconnect grace is handled by wsService; this worker is backup safety
 */

import logger from "../logger/logger";
import Device from "../models/Device";
import wsService from "../services/wsService";

const INTERVAL_MS = 1000 * 10; // check every 10 seconds
const OFFLINE_THRESHOLD_MS = 1000 * 45; // 45 seconds

let timer: NodeJS.Timeout | null = null;

export function start() {
  if (timer) {
    logger.warn("heartbeatWorker: already running");
    return;
  }

  timer = setInterval(() => {
    run().catch((err) => logger.error("heartbeatWorker error", err));
  }, INTERVAL_MS);

  run().catch((err) => logger.error("heartbeatWorker initial run failed", err));

  logger.info("heartbeatWorker: started", {
    intervalMs: INTERVAL_MS,
    offlineThresholdMs: OFFLINE_THRESHOLD_MS,
  });
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  logger.info("heartbeatWorker: stopped");
}

async function run() {
  logger.debug("heartbeatWorker: checking stale devices");

  try {
    const now = Date.now();
    const cutoff = now - OFFLINE_THRESHOLD_MS;

    const staleDevices = await Device.find({
      "status.online": true,
      "status.timestamp": { $lte: cutoff },
    })
      .select("deviceId status")
      .exec();

    if (!staleDevices.length) {
      logger.debug("heartbeatWorker: no stale devices");
      return;
    }

    for (const device of staleDevices) {
      try {
        const deviceId = String((device as any).deviceId || "").trim();
        if (!deviceId) continue;

        const hasWs = wsService.hasActiveDeviceConnection(deviceId);
        if (hasWs) {
          logger.info("heartbeatWorker: skipping offline mark - active ws exists", {
            deviceId,
            activeConnections: wsService.getActiveDeviceConnectionCount(deviceId),
          });
          continue;
        }

        device.status.online = false;
        device.status.timestamp = now;
        await device.save();

        try {
          wsService.notifyDeviceStatus(deviceId, {
            online: false,
            timestamp: now,
          });
        } catch (notifyErr) {
          logger.warn("heartbeatWorker: notifyDeviceStatus failed", {
            deviceId,
            err: notifyErr,
          });
        }

        logger.info("heartbeatWorker: marked OFFLINE (backup)", {
          deviceId,
          lastSeen: (device as any)?.status?.timestamp || null,
          cutoff,
        });
      } catch (err) {
        logger.warn("heartbeatWorker: failed to update stale device", err);
      }
    }
  } catch (err) {
    logger.error("heartbeatWorker: run error", err);
  }
}
