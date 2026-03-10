import mongoose, { Document, Schema } from "mongoose";

export type AppNotificationSource = "whatsapp" | "gmail" | "unknown";

export interface AppNotificationDoc extends Document {
  deviceId: string;
  packageName: string;
  sourceApp: AppNotificationSource;
  title: string;
  text: string;
  timestamp: number;
  meta?: Record<string, any>;
  expiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const APP_NOTIFICATION_TTL_MS = 2 * 24 * 60 * 60 * 1000;

function normalizeSourceApp(sourceApp?: string, packageName?: string): AppNotificationSource {
  const src = String(sourceApp || "").trim().toLowerCase();
  const pkg = String(packageName || "").trim().toLowerCase();

  if (
    src === "whatsapp" ||
    pkg === "com.whatsapp" ||
    pkg === "com.whatsapp.w4b"
  ) {
    return "whatsapp";
  }

  if (src === "gmail" || pkg === "com.google.android.gm") {
    return "gmail";
  }

  return "unknown";
}

function buildExpiresAt(sourceApp?: string, packageName?: string, timestamp?: number): Date | null {
  const normalized = normalizeSourceApp(sourceApp, packageName);
  if (normalized !== "whatsapp") return null;

  const tsNum = Number(timestamp || Date.now());
  const safeTs = Number.isFinite(tsNum) && tsNum > 0 ? tsNum : Date.now();

  return new Date(safeTs + APP_NOTIFICATION_TTL_MS);
}

const AppNotificationSchema = new Schema<AppNotificationDoc>(
  {
    deviceId: { type: String, required: true, index: true },
    packageName: { type: String, required: true, default: "" },
    sourceApp: {
      type: String,
      enum: ["whatsapp", "gmail", "unknown"],
      default: "unknown",
      index: true,
    },
    title: { type: String, default: "" },
    text: { type: String, default: "" },
    timestamp: { type: Number, required: true, index: true },
    meta: { type: Schema.Types.Mixed, default: {} },

    // Only whatsapp notifications get an expiry.
    // Gmail notifications keep expiresAt = null, so they are not TTL-deleted.
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true },
);

AppNotificationSchema.pre("validate", function (next) {
  try {
    this.sourceApp = normalizeSourceApp(this.sourceApp, this.packageName);
    this.expiresAt = buildExpiresAt(this.sourceApp, this.packageName, this.timestamp);
    next();
  } catch (err) {
    next(err as any);
  }
});

AppNotificationSchema.pre("findOneAndUpdate", function (next) {
  try {
    const update: any = this.getUpdate() || {};
    const $set = update.$set || {};

    const packageName =
      $set.packageName ??
      update.packageName ??
      "";

    const sourceApp =
      $set.sourceApp ??
      update.sourceApp ??
      "";

    const timestamp =
      $set.timestamp ??
      update.timestamp ??
      Date.now();

    const normalizedSource = normalizeSourceApp(sourceApp, packageName);
    const expiresAt = buildExpiresAt(normalizedSource, packageName, timestamp);

    update.$set = {
      ...$set,
      sourceApp: normalizedSource,
      expiresAt,
    };

    this.setUpdate(update);
    next();
  } catch (err) {
    next(err as any);
  }
});

// Fast device/source queries
AppNotificationSchema.index({ deviceId: 1, sourceApp: 1, timestamp: -1 });

// TTL index:
// - if expiresAt is a valid Date => document auto-deletes at that time
// - if expiresAt is null/missing => document is ignored by TTL deletion
AppNotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<AppNotificationDoc>(
  "AppNotification",
  AppNotificationSchema,
);