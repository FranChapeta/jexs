import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { Node, Context, NodeValue, resolve } from "@jexs/core";

// Module-level state
let transporter: Transporter | null = null;
let ethereal = false;

/**
 * Sends emails via SMTP.
 *
 * { "email": "user@example.com", "subject": "Hello", "html": "<p>Hi</p>" }
 * { "email": { "var": "$to" }, "subject": "...", "body": "plain text" }
 *
 * SMTP config from env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */
export class EmailNode extends Node {
  async email(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    if (!("subject" in def)) return undefined;

    const t = await getTransporter();
    if (!t) {
      console.error("[EmailNode] Failed to create email transporter.");
      return { success: false, error: "Email not configured" };
    }

    const to = this.toString(await resolve(def.email, context));
    const subject = this.toString(await resolve(def.subject, context));
    const text = def.body
      ? this.toString(await resolve(def.body, context))
      : undefined;
    const html = def.html
      ? this.toString(await resolve(def.html, context))
      : undefined;
    const from = def.from
      ? this.toString(await resolve(def.from, context))
      : process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@jms.local";

    try {
      const info = await t.sendMail({ from, to, subject, text, html });

      const result: Record<string, unknown> = {
        success: true,
        messageId: info.messageId,
      };

      if (ethereal) {
        const previewUrl = nodemailer.getTestMessageUrl(info);
        console.log(`[EmailNode] Preview: ${previewUrl}`);
        result.previewUrl = previewUrl;
      }

      return result;
    } catch (error) {
      const e = error as Error;
      console.error("[EmailNode] Send failed:", e.message);
      return { success: false, error: e.message };
    }
  }
}

async function getTransporter(): Promise<Transporter | null> {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;

  if (host) {
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
    });

    return transporter;
  }

  // Development: Ethereal fake SMTP
  try {
    const testAccount = await nodemailer.createTestAccount();

    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });

    ethereal = true;
    console.log(`[EmailNode] Using Ethereal (${testAccount.user})`);

    return transporter;
  } catch (error) {
    const e = error as Error;
    console.error("[EmailNode] Ethereal setup failed:", e.message);
    return null;
  }
}
