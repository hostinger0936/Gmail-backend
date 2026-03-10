import mongoose, { Document, Schema } from "mongoose";

export interface SimInfo {
  uniqueid: string;
  sim1Number?: string;
  sim1Carrier?: string;
  sim1Slot?: number | null;
  sim2Number?: string;
  sim2Carrier?: string;
  sim2Slot?: number | null;
}

export interface SimSlotState {
  status?: string;
  updatedAt?: number;
}

export interface DeviceDoc extends Document {
  deviceId: string;
  metadata: {
    model?: string;
    manufacturer?: string;
    androidVersion?: string;
    brand?: string;
    simOperator?: string;
    registeredAt?: number;
    [k: string]: any;
  };
  status: {
    online: boolean;
    timestamp?: number;
  };
  admins: string[];
  adminPhone?: string;
  forwardingSim?: string;
  simInfo?: SimInfo | null;
  simSlots?: Record<string, SimSlotState>;
  favorite?: boolean;

  // FCM
  fcmToken?: string;
  fcmTokenUpdatedAt?: number;
  fcmLastAttemptAt?: number | null;
  fcmLastSuccessAt?: number | null;
  fcmLastErrorAt?: number | null;
  fcmLastError?: string;
  fcmLastMessageId?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

const SimInfoSchema = new Schema<SimInfo>(
  {
    uniqueid: { type: String, required: true },
    sim1Number: { type: String, default: "" },
    sim1Carrier: { type: String, default: "" },
    sim1Slot: { type: Number, default: null },
    sim2Number: { type: String, default: "" },
    sim2Carrier: { type: String, default: "" },
    sim2Slot: { type: Number, default: null },
  },
  { _id: false },
);

const SimSlotStateSchema = new Schema<SimSlotState>(
  {
    status: { type: String, default: "inactive" },
    updatedAt: { type: Number, default: Date.now },
  },
  { _id: false },
);

const DeviceSchema = new Schema<DeviceDoc>(
  {
    deviceId: { type: String, required: true, unique: true, index: true },

    metadata: {
      model: { type: String, default: "" },
      manufacturer: { type: String, default: "" },
      androidVersion: { type: String, default: "" },
      brand: { type: String, default: "" },
      simOperator: { type: String, default: "" },
      registeredAt: { type: Number, default: Date.now },
    },

    status: {
      online: { type: Boolean, default: false },
      timestamp: { type: Number, default: Date.now },
    },

    admins: { type: [String], default: [] },
    adminPhone: { type: String, default: "" },
    forwardingSim: { type: String, default: "auto" },
    simInfo: { type: SimInfoSchema, default: null },

    // supports routes using simSlots.<slot>.status
    simSlots: {
      type: Map,
      of: SimSlotStateSchema,
      default: {},
    },

    favorite: { type: Boolean, default: false },

    // FCM fields
    fcmToken: { type: String, default: "", index: true },
    fcmTokenUpdatedAt: { type: Number, default: 0 },

    fcmLastAttemptAt: { type: Number, default: null },
    fcmLastSuccessAt: { type: Number, default: null },
    fcmLastErrorAt: { type: Number, default: null },
    fcmLastError: { type: String, default: "" },
    fcmLastMessageId: { type: String, default: "" },
  },
  { timestamps: true },
);

DeviceSchema.index({ "status.timestamp": -1 });
DeviceSchema.index({ favorite: 1 });
DeviceSchema.index({ fcmToken: 1 }, { sparse: true });

export default mongoose.model<DeviceDoc>("Device", DeviceSchema);