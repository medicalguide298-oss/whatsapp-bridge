/**
 * WhatsApp Baileys Bridge Server
 * Provides HTTP REST API endpoints for Pharmacy Post Pro:
 * - GET  /status      -> Check WhatsApp link status, QR code, and phone
 * - GET  /groups      -> List WhatsApp groups joined by the phone
 * - POST /channel     -> Resolve WhatsApp newsletter/channel link
 * - POST /send        -> Send post image & caption to a group or channel
 * - POST /send-status -> Post image & caption to WhatsApp Status (status@broadcast) with group mentioned
 * - POST /logout      -> Unlink WhatsApp account
 */

import express from "express";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = Number(process.env.PORT) || 8080;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.ADMIN_TOKEN || "";
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "auth_info_baileys");

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Public health check endpoints for cloud platforms (Back4app, Render, Railway probes)
app.get(["/", "/health", "/ping"], (req, res) => {
  res.status(200).json({ ok: true, status: "healthy", service: "pharmacy-whatsapp-bridge" });
});

// Security: Verify Bearer Token on API routes
function authMiddleware(req, res, next) {
  if (!BRIDGE_TOKEN) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Missing or invalid Authorization header" });
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token !== BRIDGE_TOKEN) {
    return res.status(403).json({ ok: false, error: "Invalid bridge token" });
  }
  next();
}

app.use(authMiddleware);

// ==============================================================================
// Multi-Company / Multi-Tenant Session Management
// ==============================================================================

const sessions = new Map();

function sanitizeCompanyId(id) {
  if (!id) return "default";
  return (
    String(id)
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64) || "default"
  );
}

function extractCompanyId(req) {
  const fromHeader = req.headers["x-company-id"] || req.headers["x-session-id"];
  const fromQuery = req.query?.companyId || req.query?.sessionId;
  const fromBody = req.body && (req.body.companyId || req.body.sessionId);
  return sanitizeCompanyId(fromHeader || fromQuery || fromBody || "default");
}

function getCompanyAuthDir(companyId) {
  const safeId = sanitizeCompanyId(companyId);
  return path.join(AUTH_DIR, `session_${safeId}`);
}

async function getOrCreateSession(companyId, autoConnect = true) {
  const id = sanitizeCompanyId(companyId);
  if (sessions.has(id)) {
    return sessions.get(id);
  }

  const session = {
    id,
    sock: null,
    status: "offline",
    lastQr: null,
    phone: null,
    groups: [],
    reconnectAttempts: 0,
    connectingPromise: null,
  };
  sessions.set(id, session);

  if (autoConnect) {
    connectSession(session).catch((err) => {
      logger.error({ err, companyId: id }, "Initial connect failed for company");
    });
  }

  return session;
}

async function connectSession(session) {
  if (session.connectingPromise) return session.connectingPromise;

  session.connectingPromise = (async () => {
    const sessionDir = getCompanyAuthDir(session.id);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["Pharmacy Post Pro", "Chrome", "1.0.0"],
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
    });

    session.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          session.lastQr = await QRCode.toDataURL(qr);
          session.status = "waiting_for_qr";
          logger.info({ companyId: session.id }, "QR code refreshed for company session");
        } catch (e) {
          logger.error({ err: e, companyId: session.id }, "Failed to generate QR data URL");
        }
      }

      if (connection === "open") {
        session.status = "online";
        session.lastQr = null;
        session.reconnectAttempts = 0;
        session.phone = sock.user?.id ? sock.user.id.split(":")[0] : "connected";
        logger.info({ phone: session.phone, companyId: session.id }, "WhatsApp connected successfully");

        refreshGroups(session).catch(() => {});
      }

      if (connection === "close") {
        session.status = "offline";
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn(
          { statusCode, shouldReconnect, companyId: session.id },
          "WhatsApp connection closed",
        );

        if (shouldReconnect) {
          session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
          const delay = Math.min(30000, 2000 * Math.pow(1.5, session.reconnectAttempts));
          setTimeout(() => {
            connectSession(session).catch(() => {});
          }, delay);
        } else {
          session.phone = null;
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch {}
        }
      }
    });

    return session;
  })().finally(() => {
    session.connectingPromise = null;
  });

  return session.connectingPromise;
}

async function refreshGroups(session) {
  if (!session.sock || session.status !== "online") return [];
  try {
    const data = await session.sock.groupFetchAllParticipating();
    const list = Object.values(data).map((g) => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0,
      creation: g.creation,
    }));
    session.groups = list;
    return list;
  } catch (err) {
    logger.warn({ err, companyId: session.id }, "Failed to fetch participating groups");
    return session.groups || [];
  }
}

// ==============================================================================
// REST Endpoints
// ==============================================================================

app.get("/status", async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, true);

  if (session.status === "offline" && !session.sock) {
    connectSession(session).catch(() => {});
  }

  res.json({
    ok: true,
    companyId: session.id,
    status: session.status,
    phone: session.phone,
    qrCode: session.status === "waiting_for_qr" ? session.lastQr : null,
    groupsCount: session.groups.length,
  });
});

app.get("/groups", async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, true);

  if (session.status !== "online") {
    return res.status(503).json({
      ok: false,
      companyId: session.id,
      error: "WhatsApp is not connected for this company",
      status: session.status,
    });
  }

  const groups = await refreshGroups(session);
  res.json({
    ok: true,
    companyId: session.id,
    groups,
  });
});

app.post("/channel", async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, true);

  if (session.status !== "online") {
    return res.status(503).json({
      ok: false,
      error: "WhatsApp is not connected for this company",
    });
  }

  const { inviteCode, url } = req.body || {};
  let code = inviteCode;
  if (!code && url) {
    const match = String(url).match(/whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/);
    if (match) code = match[1];
  }

  if (!code) {
    return res.status(400).json({ ok: false, error: "Missing channel inviteCode or url" });
  }

  try {
    const metadata = await session.sock.newsletterMetadata("invite", code);
    return res.json({
      ok: true,
      companyId: session.id,
      channel: {
        id: metadata.id,
        name: metadata.thread_metadata?.name?.text || "Channel",
        subscribers: metadata.thread_metadata?.subscribers_count || 0,
      },
    });
  } catch (err) {
    logger.error({ err, code, companyId: session.id }, "Failed to resolve newsletter channel");
    return res.status(404).json({
      ok: false,
      error: `Could not resolve channel link: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

app.post("/send", async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, true);

  if (session.status !== "online" || !session.sock) {
    return res.status(503).json({
      ok: false,
      companyId: session.id,
      error: "WhatsApp is not connected. Scan QR code first.",
    });
  }

  const { groupId, imageUrl, videoUrl, mediaUrl, isVideo, caption, mentionedJid } = req.body || {};

  if (!groupId) {
    return res.status(400).json({ ok: false, error: "Missing 'groupId'" });
  }

  const effectiveMedia = videoUrl || imageUrl || mediaUrl;
  const effectiveIsVideo = Boolean(
    isVideo ||
      videoUrl ||
      (effectiveMedia &&
        (/\.(mp4|mov|webm)(\?.*)?$/i.test(effectiveMedia) ||
          effectiveMedia.includes("video/"))),
  );

  let targetJid = String(groupId).trim();
  if (!targetJid.includes("@")) {
    targetJid = `${targetJid}@g.us`;
  }

  try {
    let messagePayload;

    if (effectiveMedia) {
      const mediaResponse = await fetch(effectiveMedia);
      if (!mediaResponse.ok) {
        throw new Error(`Failed to download media (${mediaResponse.status})`);
      }
      const arrayBuffer = await mediaResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (effectiveIsVideo) {
        messagePayload = {
          video: buffer,
          caption: caption || "",
          mimetype: "video/mp4",
          mentions: Array.isArray(mentionedJid) ? mentionedJid : undefined,
        };
      } else {
        messagePayload = {
          image: buffer,
          caption: caption || "",
          mimetype: "image/png",
          mentions: Array.isArray(mentionedJid) ? mentionedJid : undefined,
        };
      }
    } else {
      messagePayload = {
        text: caption || "",
        mentions: Array.isArray(mentionedJid) ? mentionedJid : undefined,
      };
    }

    const sent = await session.sock.sendMessage(targetJid, messagePayload);

    return res.json({
      ok: true,
      companyId: session.id,
      messageId: sent?.key?.id,
      targetJid,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error({ err, targetJid, companyId: session.id }, "Error sending message");
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to send message",
    });
  }
});

app.post("/send-status", async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, true);

  if (session.status !== "online" || !session.sock) {
    return res.status(503).json({
      ok: false,
      companyId: session.id,
      error: "WhatsApp is not connected.",
    });
  }

  const { imageUrl, videoUrl, mediaUrl, isVideo, caption, mentionedJid } = req.body || {};
  const effectiveMedia = videoUrl || imageUrl || mediaUrl;
  const effectiveIsVideo = Boolean(isVideo || videoUrl);

  try {
    let messagePayload;
    if (effectiveMedia) {
      const mediaResponse = await fetch(effectiveMedia);
      if (!mediaResponse.ok) throw new Error("Could not download media");
      const buffer = Buffer.from(await mediaResponse.arrayBuffer());

      messagePayload = effectiveIsVideo
        ? { video: buffer, caption: caption || "", mimetype: "video/mp4" }
        : { image: buffer, caption: caption || "", mimetype: "image/png" };
    } else {
      messagePayload = { text: caption || "" };
    }

    if (Array.isArray(mentionedJid) && mentionedJid.length) {
      messagePayload.mentions = mentionedJid;
    }

    const sent = await session.sock.sendMessage("status@broadcast", messagePayload);
    return res.json({
      ok: true,
      companyId: session.id,
      statusPosted: true,
      messageId: sent?.key?.id,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to post status",
    });
  }
});

app.post("/logout", async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = sessions.get(companyId);

  if (!session) {
    return res.json({ ok: true, message: "No active session" });
  }

  try {
    if (session.sock) {
      await session.sock.logout();
    }
  } catch {}

  const dir = getCompanyAuthDir(session.id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}

  sessions.delete(companyId);
  return res.json({ ok: true, companyId, message: "Logged out successfully" });
});

// Start listening
app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, `WhatsApp bridge server running on port ${PORT}`);
  getOrCreateSession("default", true).catch(() => {});
});
