import https from "https";
import fs from "fs";
import crypto from "crypto";
import "dotenv/config";
import cluster from "cluster";
import os from "os";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import pool from "./db/postgres.js";
import admin from "firebase-admin";
import { autoSubmitExam } from "./controllers/exams/exam.controller.js";

import authRoutes from "./routes/auth.routes.js";
import usersRoutes from "./routes/users.routes.js";
import managerRoutes from "./routes/manager.routes.js";
import coursesRoutes from "./routes/courses.routes.js";
import moduleRoutes from "./routes/module.routes.js";
import assignmentsRoutes from "./routes/assignments.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import studentCoursesRoutes from "./routes/studentCourses.routes.js";
import examRoutes from "./routes/exam.routes.js";
import studentExamRoutes from "./routes/studentExam.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import groupsRoutes from "./routes/group.routes.js";
import practiceRoutes from "./routes/practice.routes.js";
import proctoringRoutes from "./routes/proctoring.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import http from "http";
import { Server } from "socket.io";
import { initChatTables, serveFile } from "./controllers/chat.controller.js";
import firebaseAuth from "./middlewares/firebaseAuth.js";
import attachUser from "./middlewares/attachUser.js";
import botRoutes from "./routes/bot.routes.js";
import reviewroutes from "./routes/reviews.routes.js";
import certificateRoutes from "./routes/certificate.routes.js";
import contestRoutes from "./routes/contest.routes.js";
import contestQuestionRoutes from "./routes/contestQuestion.routes.js";
import contestAdvancedRoutes from "./routes/contestAdvanced.routes.js";
import { router as admingroupsRoutes } from "./routes/admingroups.routes.js";
import courseCommentsRoutes from "./routes/courseComments.routes.js";
import learningPathRoutes from "./routes/LearningPath.routes.js";
import mocktestRoutes from "./routes/mocktest.routes.js";
import supportRoutes from "./routes/support.routes.js";
import seoRoutes from "./routes/seo.routes.js";
import studentReviewsRoutes from "./routes/studentReviews.routes.js";
import contentSettingsRoutes from "./routes/contentSettings.routes.js";
import { initializeDatabase } from "./db/dbInit.js";
import { getExecutionQueueStats } from "./services/executionQueue.service.js";
import { resolveExecutionTempRoot } from "./utils/executionTemp.js";
import { serveLocalStorageObject } from "./services/s3Storage.service.js";
import { getCspDirectives } from "./security/csp.js";
import { initRedis } from "./services/cache.service.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("trust proxy", 1);

// Lightweight request logging middleware for debugging preflight OPTIONS requests in production
app.use((req, res, next) => {
  console.log(`[HTTP LOG] ${req.method} ${req.url} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: getCspDirectives(),
    },

    crossOriginEmbedderPolicy: false,

    crossOriginOpenerPolicy: {
      policy: "same-origin-allow-popups",
    },

    crossOriginResourcePolicy: {
      policy: "cross-origin",
    },

    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
  }),
);
const server = http.createServer(app);
const normalizeBaseUrl = (value) => String(value || "").replace(/\/+$/, "");
const buildChatMediaUrl = (baseUrl, fileId) => {
  if (!baseUrl || !fileId) return null;
  return `${baseUrl}/api/chats/media/${fileId}`;
};
const getPublicBackendBaseUrlFromHeaders = (
  headers = {},
  fallbackProtocol = "https",
) => {
  const configuredBase = normalizeBaseUrl(
    process.env.PUBLIC_BACKEND_URL ||
      process.env.BACKEND_PUBLIC_URL ||
      process.env.BACKEND_URL,
  );

  if (configuredBase && !/localhost|127\.0\.0\.1/i.test(configuredBase)) {
    return configuredBase;
  }

  const forwardedProto = String(
    headers["x-forwarded-proto"] || fallbackProtocol || "https",
  )
    .split(",")[0]
    .trim();
  const forwardedHost = String(
    headers["x-forwarded-host"] || headers.host || "",
  )
    .split(",")[0]
    .trim();

  if (!forwardedHost) return configuredBase;
  return `${forwardedProto}://${forwardedHost}`;
};
const configuredOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:4173", // Vite preview server
  process.env.FRONTEND_URL,
  "http://vanshika-project-frontend.s3-website.eu-north-1.amazonaws.com",
  "https://lms.shnoor.com",
  ...configuredOrigins,
].filter(Boolean);

const runHealthCommand = (cmd, args, timeoutMs = 3000) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args);
    } catch (err) {
      resolve({ ok: false, output: "", error: err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {
        /* ignore */
      }
      done({ ok: false, output: stdout.trim(), error: "Timed out" });
    }, timeoutMs);

    child.stdout.on("data", (data) => (stdout += data.toString()));
    child.stderr.on("data", (data) => (stderr += data.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, output: stdout.trim(), error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({
        ok: code === 0,
        output: stdout.trim(),
        error: stderr.trim(),
        exitCode: code,
      });
    });
  });

const runnerImages = [
  "node:20-alpine",
  "python:3.11-alpine",
  "amazoncorretto:17-alpine-jdk",
  "gcc:13",
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 60000,
});
global.io = io;

/* =====================================
    SOCKET AUTH MIDDLEWARE
   Verify Firebase Token
===================================== */
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("Authentication token missing"));
    }

    const decoded = await admin.auth().verifyIdToken(token);

    const { rows } = await pool.query(
      `SELECT user_id FROM users WHERE firebase_uid = $1`,
      [decoded.uid],
    );

    if (!rows.length) {
      return next(new Error("User not found in database"));
    }

    socket.userId = rows[0].user_id;
    socket.firebaseUid = decoded.uid;
    next();
  } catch (err) {
    console.error("Socket authentication error:", err);
    next(new Error("Authentication failed: " + err.message));
  }
});

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log("CORS blocked:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200, // Return standard 200 status for legacy preflight clients
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions)); // Handle preflight OPTIONS across-the-board

app.use(express.json());
app.use("/api/storage", serveLocalStorageObject);

// Log 401 errors to help debug unauthorized requests
app.use((req, res, next) => {
  const originalJson = res.json;
  const originalSendStatus = res.sendStatus;
  const originalSend = res.send;

  res.json = function (body) {
    if (res.statusCode === 401) {
      console.warn(
        `[401 UNAUTHORIZED] ${req.method} ${req.url} - IP: ${req.ip}`,
      );
      console.warn(`Headers:`, req.headers);
    }
    return originalJson.call(this, body);
  };

  res.sendStatus = function (code) {
    if (code === 401) {
      console.warn(`[401 UNAUTHORIZED] ${req.method} ${req.url} - SendStatus`);
    }
    return originalSendStatus.call(this, code);
  };

  res.send = function (body) {
    if (res.statusCode === 401) {
      console.warn(`[401 UNAUTHORIZED] ${req.method} ${req.url} - Send`);
    }
    return originalSend.call(this, body);
  };

  next();
});

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/manager", managerRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api", moduleRoutes);
app.use("/api/assignments", assignmentsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/groups", groupsRoutes);
app.use("/api/student", studentCoursesRoutes);
app.use("/api/exams", examRoutes);
// Backward-compatible alias for older frontend routes
app.use("/api/exam", examRoutes);
app.use("/api/student/exams", studentExamRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/practice", practiceRoutes);
app.use("/api/proctoring", proctoringRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/bot", botRoutes);
app.use("/api/reviews", reviewroutes);
app.use("/api/certificate", certificateRoutes);
app.use("/api/contests", contestRoutes);
app.use("/api/contests", contestQuestionRoutes);
app.use("/api/contests", contestAdvancedRoutes);
app.use("/api/admingroups", admingroupsRoutes);
app.use("/api", courseCommentsRoutes);
app.use("/api/mocktest", mocktestRoutes);
app.use("/api/learning-paths", learningPathRoutes);
app.use("/api/support-queries", supportRoutes);
app.use("/api/student-reviews", studentReviewsRoutes);
app.use("/api/content-settings", contentSettingsRoutes);
app.use("/seo", seoRoutes);

app.get("/", (req, res) => {
  res.send("API is running ");
});

app.get("/api/health/execution", async (req, res) => {
  const dockerVersion = await runHealthCommand("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  const images = await Promise.all(
    runnerImages.map(async (image) => {
      const result = await runHealthCommand(
        "docker",
        ["image", "inspect", image],
        3000,
      );
      return {
        image,
        available: result.ok,
        error: result.ok
          ? null
          : result.error || result.output || "Image not available",
      };
    }),
  );

  const body = {
    status:
      dockerVersion.ok && images.every((image) => image.available)
        ? "ok"
        : "degraded",
    mode: process.env.CODE_EXECUTION_MODE || "auto",
    allowUnsafeLocalExecution:
      String(process.env.ALLOW_UNSAFE_LOCAL_EXECUTION || "").toLowerCase() ===
      "true",
    processRole: process.env.PROCESS_ROLE || "api",
    tempRoot: resolveExecutionTempRoot(),
    queue: getExecutionQueueStats(),
    docker: {
      available: dockerVersion.ok,
      version: dockerVersion.ok ? dockerVersion.output : null,
      error: dockerVersion.ok
        ? null
        : dockerVersion.error || dockerVersion.output,
    },
    images,
  };

  res.status(body.status === "ok" ? 200 : 503).json(body);
});

app.get("/api/chats/media/:id", firebaseAuth, attachUser, serveFile);

const userSockets = new Map();

io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);
  if (socket.userId) {
    console.log(`Authenticated user: ${socket.userId}`);
  }

  socket.on("join_user", (userId) => {
    if (socket.userId !== userId) {
      console.warn(`Socket ${socket.id} attempted to join user_${userId} but is authenticated as ${socket.userId}`);
      return;
    }
    socket.join(`user_${userId}`);
    console.log(`User ${userId} joined room user_${userId}`);
  });

  /* =========================
     STUDENT STARTS EXAM
  ========================= */
  socket.on("exam:start", async ({ examId }) => {
    const userId = socket.userId;

    //  ATTEMPT-AWARE VIRTUAL ID RESOLUTION
    if (examId && examId.startsWith("final_")) {
      const courseId = examId.replace("final_", "");
      const { rows: resolvedExams } = await pool.query(
        `
        SELECT e.exam_id 
        FROM exams e
        LEFT JOIN exam_courses ec ON ec.exam_id = e.exam_id
        LEFT JOIN exam_attempts ea ON ea.exam_id = e.exam_id AND ea.student_id = $2
        WHERE (e.course_id = $1 OR ec.course_id = $1)
        ORDER BY (ea.exam_id IS NOT NULL) DESC, e.created_at DESC
        LIMIT 1
        `,
        [courseId, userId],
      );
      if (resolvedExams.length) {
        console.log(
          ` RESOLVED socket examId from ${examId} to ${resolvedExams[0].exam_id}`,
        );
        examId = resolvedExams[0].exam_id;
      }
    }

    socket.examId = examId;

    console.log(`User ${userId} started exam ${examId}`);
    console.log(
      ` Checking disconnect state for user ${userId}, exam ${examId}`,
    );

    if (!userId || !examId) {
      console.log(`exam:start ignored - no userId or examId`);
      return;
    }

    try {
      console.log(`Checking status for user ${userId}, exam ${examId}...`);

      // Start the timer ONLY NOW, when the client confirms they are actually starting
      await pool.query(
        `
        UPDATE exam_attempts
        SET status = 'in_progress',
            start_time = CASE
              WHEN status = 'pending' OR start_time IS NULL THEN NOW()
              ELSE start_time
            END,
            end_time = CASE
              WHEN status = 'pending' OR end_time IS NULL
                THEN NOW() + (SELECT duration FROM exams WHERE exam_id = $1) * INTERVAL '1 minute'
              ELSE end_time
            END,
            disconnected_at = NULL
        WHERE exam_id = $1
          AND student_id = $2
          AND (
            status = 'pending'
            OR start_time IS NULL
            OR end_time IS NULL
          )
        `,
        [examId, userId],
      );

      const { rows } = await pool.query(
        `
        SELECT
          ea.status,
          ea.disconnected_at,
          ea.end_time,
          GREATEST(COALESCE(e.disconnect_grace_time, 0), 120) AS disconnect_grace_time,
          NOW() as server_time
        FROM exam_attempts ea
        JOIN exams e ON e.exam_id = ea.exam_id
        WHERE ea.exam_id = $1 AND ea.student_id = $2
        `,
        [examId, userId],
      );

      console.log(`Query result:`, rows);

      if (rows.length > 0 && rows[0].status === "submitted") {
        console.log(
          ` Exam ${examId} was auto-submitted for user ${userId} during disconnection`,
        );
        console.log(
          ` Emitting exam:autoSubmitted event to socket ${socket.id}`,
        );

        socket.emit("exam:autoSubmitted", {
          examId,
          message: "Exam was auto-submitted due to disconnection",
        });

        console.log(`Event emitted successfully`);
      } else if (rows.length > 0) {
        socket.emit("exam:started", {
          endTime: rows[0].end_time,
          serverTime: rows[0].server_time,
        });

        const disconnectedAt = rows[0].disconnected_at;
        const endTime = rows[0].end_time;
        const graceSeconds = rows[0].disconnect_grace_time || 0;
        const { rows: nowRows } = await pool.query(`SELECT NOW() AS now`);
        const now = nowRows[0].now;

        const deadlineMs = endTime
          ? new Date(endTime).getTime() + graceSeconds * 1000
          : null;

        if (deadlineMs && new Date(now).getTime() > deadlineMs) {
          console.log(
            ` Attempt exceeded end time. Auto-submitting exam ${examId} for user ${userId}`,
          );
          await autoSubmitExam(userId, examId);
          socket.emit("exam:autoSubmitted", {
            examId,
            message: "Exam auto-submitted due to time expiry",
          });
          return;
        }

        if (disconnectedAt) {
          const offlineSeconds = Math.floor(
            (new Date(now).getTime() - new Date(disconnectedAt).getTime()) /
              1000,
          );

          console.log(
            ` Offline duration: ${offlineSeconds}s (grace ${graceSeconds}s)`,
          );

          if (offlineSeconds > graceSeconds) {
            console.log(
              ` Offline grace exceeded. Auto-submitting exam ${examId} for user ${userId}`,
            );
            await autoSubmitExam(userId, examId);
            socket.emit("exam:autoSubmitted", {
              examId,
              message: "Exam auto-submitted due to disconnection",
            });
          } else {
            await pool.query(
              `
              UPDATE exam_attempts
              SET disconnected_at = NULL
              WHERE exam_id = $1 AND student_id = $2
              `,
              [examId, userId],
            );
            console.log(
              ` Reconnected within grace. Cleared disconnected_at.`,
            );
          }
        } else {
          console.log(
            `✓ Exam ${examId} not yet submitted, continuing normally`,
          );
        }
      } else {
        console.log(`No attempt found for exam ${examId}, user ${userId}`);
      }
    } catch (err) {
      console.error("Error checking exam status on reconnect:", err);
    }
  });

  socket.on("join_chat", async (chatId) => {
    try {
      const userId = socket.userId;
      if (!userId) {
        console.warn(`Socket ${socket.id} join_chat ignored: no authenticated user`);
        return;
      }
      
      const chatCheck = await pool.query(
        "SELECT 1 FROM chats WHERE chat_id = $1 AND (instructor_id = $2 OR student_id = $2)",
        [chatId, userId]
      );
      
      const userRoleCheck = await pool.query(
        "SELECT role FROM users WHERE user_id = $1",
        [userId]
      );
      const userRole = userRoleCheck.rows[0]?.role;
      const isAdminOrManager = userRole === "admin" || userRole === "manager";

      if (chatCheck.rows.length > 0 || isAdminOrManager) {
        socket.join(`chat_${chatId}`);
        console.log(`Socket ${socket.id} (user ${userId}) joined chat_${chatId}`);
      } else {
        console.warn(`Socket ${socket.id} (user ${userId}) attempted to join chat_${chatId} but lacks permission`);
      }
    } catch (err) {
      console.error("Error in join_chat socket handler:", err);
    }
  });

  socket.on("join_group", async (groupId) => {
    try {
      const userId = socket.userId;
      if (!userId) {
        console.warn(`Socket ${socket.id} join_group ignored: no authenticated user`);
        return;
      }

      const userRoleCheck = await pool.query(
        "SELECT role FROM users WHERE user_id = $1",
        [userId]
      );
      const userRole = userRoleCheck.rows[0]?.role;
      const isAdminOrManager = userRole === "admin" || userRole === "manager";

      if (isAdminOrManager) {
        socket.join(`group_${groupId}`);
        console.log(`Socket ${socket.id} (user ${userId}, admin/manager) joined group_${groupId}`);
        return;
      }

      const clgCheck = await pool.query(
        "SELECT 1 FROM clg_group_members WHERE group_id = $1 AND user_id = $2",
        [groupId, userId]
      );

      const adminCheck = await pool.query(
        "SELECT 1 FROM admin_group_members WHERE group_id = $1 AND user_id = $2",
        [groupId, userId]
      );

      if (clgCheck.rows.length > 0 || adminCheck.rows.length > 0) {
        socket.join(`group_${groupId}`);
        console.log(`Socket ${socket.id} (user ${userId}) joined group_${groupId}`);
      } else {
        console.warn(`Socket ${socket.id} (user ${userId}) attempted to join group_${groupId} but lacks permission`);
      }
    } catch (err) {
      console.error("Error in join_group socket handler:", err);
    }
  });

  socket.on("send_message", async (data, callback) => {
    const authenticatedSenderId = socket.userId;
    if (!authenticatedSenderId) {
      console.warn("send_message rejected: unauthenticated socket");
      return;
    }

    const {
      chatId,
      groupId,
      text,
      senderUid,
      senderName,
      recipientId,
      attachment_file_id,
      attachment_type,
      attachment_name,
      reply_to_message_id,
    } = data;

    try {
      const runtimeBaseUrl = getPublicBackendBaseUrlFromHeaders(
        socket.handshake?.headers || {},
        socket.handshake?.secure ? "https" : "http",
      );

      // Handle GROUP messages
      if (groupId) {
        const groupCheck = await pool.query(
          "SELECT 1 FROM admin_groups WHERE group_id = $1",
          [groupId],
        );

        const isAdminGroup = groupCheck.rows.length > 0;

        const memberTable = isAdminGroup ? "admin_group_members" : "clg_group_members";
        const userRoleCheck = await pool.query(
          "SELECT role FROM users WHERE user_id = $1",
          [authenticatedSenderId]
        );
        const userRole = userRoleCheck.rows[0]?.role;
        const isAdminOrManager = userRole === "admin" || userRole === "manager";

        let isMember = isAdminOrManager;
        if (!isMember) {
          const memberCheck = await pool.query(
            `SELECT 1 FROM ${memberTable} WHERE group_id = $1 AND user_id = $2`,
            [groupId, authenticatedSenderId]
          );
          isMember = memberCheck.rows.length > 0;
        }

        if (!isMember) {
          console.warn(`User ${authenticatedSenderId} attempted to send message to group ${groupId} but is not a member`);
          return;
        }

        let result;

        if (isAdminGroup) {
          // Admin group → admin_group_messages table
          result = await pool.query(
            `INSERT INTO admin_group_messages (
                group_id, sender_id, text,
                attachment_file_id, attachment_type, attachment_name
            )
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              groupId,
              authenticatedSenderId,
              text || "",
              attachment_file_id || null,
              attachment_type || null,
              attachment_name || null,
            ],
          );
        } else {
          // College group → messages table (where frontend reads from!)
          result = await pool.query(
            `INSERT INTO messages (
                group_id, sender_id, text,
                attachment_file_id, attachment_type, attachment_name,
                reply_to_message_id
            )
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              groupId,
              authenticatedSenderId,
              text || "",
              attachment_file_id || null,
              attachment_type || null,
              attachment_name || null,
              reply_to_message_id || null,
            ],
          );
        }

        const savedMsg = result.rows[0];
        console.log(
          ` ${isAdminGroup ? "Admin" : "College"} group message saved:`,
          savedMsg,
        );

        const payload = {
          ...savedMsg,
          text: savedMsg.text ?? savedMsg.message ?? text ?? "",
          sender_uid: senderUid,
          sender_name: senderName,
          attachment_url: savedMsg.attachment_file_id
            ? buildChatMediaUrl(runtimeBaseUrl, savedMsg.attachment_file_id)
            : null,
        };

        console.log(
          " Broadcasting receive_message to group_" +
            groupId +
            " (excluding sender)",
        );
        socket.broadcast
          .to(`group_${groupId}`)
          .emit("receive_message", payload);

        if (callback) callback(payload);

        // Notify all group members except sender
        const membersResult = await pool.query(
          `SELECT user_id FROM ${memberTable} WHERE group_id = $1 AND user_id != $2`,
          [groupId, authenticatedSenderId],
        );

        membersResult.rows.forEach((member) => {
          io.to(`user_${member.user_id}`).emit("new_notification", {
            group_id: groupId,
            sender_id: authenticatedSenderId,
            sender_name: senderName,
            text: text || "Sent an attachment",
            created_at: savedMsg.created_at,
          });
        });

        const groupTable = isAdminGroup ? "admin_groups" : "college_groups";
        await pool.query(
          `UPDATE ${groupTable} SET updated_at = NOW() WHERE group_id = $1`,
          [groupId],
        );
        console.log(
          ` ${isAdminGroup ? "Admin" : "College"} group message handling complete`,
        );
      }
      // Handle DM messages
      else if (chatId) {
        const chatCheck = await pool.query(
          "SELECT student_id, instructor_id FROM chats WHERE chat_id = $1",
          [chatId]
        );
        if (chatCheck.rows.length === 0) {
          console.warn(`Chat ${chatId} not found`);
          return;
        }
        const { student_id, instructor_id } = chatCheck.rows[0];
        if (authenticatedSenderId !== student_id && authenticatedSenderId !== instructor_id) {
          console.warn(`User ${authenticatedSenderId} attempted to send message to chat ${chatId} but is not a participant`);
          return;
        }

        const expectedRecipientId = authenticatedSenderId === student_id ? instructor_id : student_id;

        const result = await pool.query(
          `INSERT INTO messages (
                chat_id, sender_id, receiver_id, text, 
                attachment_file_id, attachment_type, attachment_name,
                reply_to_message_id
            ) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
             RETURNING *`,
          [
            chatId,
            authenticatedSenderId,
            expectedRecipientId,
            text || "",
            attachment_file_id || null,
            attachment_type || null,
            attachment_name || null,
            reply_to_message_id || null,
          ],
        );
        const savedMsg = result.rows[0];
        console.log("DM message saved to database:", savedMsg);

        const payload = {
          ...savedMsg,
          sender_uid: senderUid,
          sender_name: senderName,
          attachment_url: savedMsg.attachment_file_id
            ? buildChatMediaUrl(runtimeBaseUrl, savedMsg.attachment_file_id)
            : null,
        };

        console.log(
          " Broadcasting receive_message to chat_" +
            chatId +
            " (excluding sender)",
        );
        socket.broadcast.to(`chat_${chatId}`).emit("receive_message", payload);

        if (callback) callback(payload);

        console.log("Emitting new_notification to user_" + expectedRecipientId);
        io.to(`user_${expectedRecipientId}`).emit("new_notification", {
          chat_id: chatId,
          sender_id: authenticatedSenderId,
          sender_name: senderName,
          text: text || "Sent an attachment",
          created_at: savedMsg.created_at,
        });

        await pool.query(
          "UPDATE chats SET updated_at = NOW() WHERE chat_id = $1",
          [chatId],
        );
        console.log("DM message handling complete");
      }
    } catch (err) {
      console.error("Socket Message Error:", err);
    }
  });

  socket.on("disconnect", async () => {
    console.log("Socket Disconnected:", socket.id);

    const userId = socket.userId;

    if (userId) {
      console.log(`Tracking disconnect for user: ${userId}`);
      try {
        const { rows } = await pool.query(
          `
          SELECT
            ea.exam_id,
            ea.end_time,
            GREATEST(COALESCE(e.disconnect_grace_time, 0), 120) AS disconnect_grace_time
          FROM exam_attempts ea
          JOIN exams e ON e.exam_id = ea.exam_id
          WHERE ea.student_id = $1 
          AND ea.status = 'in_progress' 
          AND ea.disconnected_at IS NULL
          AND NOW() >= ea.start_time + INTERVAL '30 seconds'
          AND NOW() < ea.end_time + (GREATEST(COALESCE(e.disconnect_grace_time, 0), 120) * INTERVAL '1 second')
          `,
          [userId],
        );

        if (rows.length === 0) {
          console.log(
            ` No active in-progress attempts found for user ${userId}`,
          );
        } else {
          for (const row of rows) {
            await pool.query(
              `
              UPDATE exam_attempts
              SET disconnected_at = NOW()
              WHERE exam_id = $1
              AND student_id = $2
              AND status = 'in_progress'
              `,
              [row.exam_id, userId],
            );
            console.log(
              ` Marked disconnected_at for user ${userId}, exam ${row.exam_id}`,
            );
          }
        }

        const { rows: expiredRows } = await pool.query(
          `
          SELECT ea.exam_id
          FROM exam_attempts ea
          JOIN exams e ON e.exam_id = ea.exam_id
          WHERE ea.student_id = $1 
          AND ea.status = 'in_progress'
          AND NOW() >= ea.end_time + (GREATEST(COALESCE(e.disconnect_grace_time, 0), 120) * INTERVAL '1 second')
          `,
          [userId],
        );

        for (const row of expiredRows) {
          console.log(
            ` Auto-submitting expired exam ${row.exam_id} for user ${userId} on disconnect`,
          );
          await autoSubmitExam(userId, row.exam_id);
        }
      } catch (err) {
        console.error("Disconnect handling error:", err);
        console.error(err.stack);
      }
    }
  });
});

app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(500).json({ message: "Internal server error" });
});

// REPLACE WITH:
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

const sslOptions = (() => {
  try {
    return {
      key: fs.readFileSync(new URL("./privkey.pem", import.meta.url)),
      cert: fs.readFileSync(new URL("./fullchain.pem", import.meta.url)),
    };
  } catch (e) {
    console.log("SSL certificates not found. Running in local HTTP mode.");
    return null;
  }
})();

// Redirect HTTP (port 80) → HTTPS only if SSL is enabled
if (sslOptions) {
  http
    .createServer((req, res) => {
      res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
      res.end();
    })
    .listen(process.env.HTTP_PORT || 80, () => {
      console.log(`HTTP redirect on port ${process.env.HTTP_PORT || 80}`);
    })
    .on("error", (err) => {
      console.error("HTTP redirect error:", err.message);
    });
}

if (process.env.CLUSTER_ENABLED === "true" && cluster.isPrimary) {
  pool
    .query("SELECT NOW()")
    .then(async () => {
      console.log("Database connected successfully (Primary)");
      await initializeDatabase();
      await initChatTables();
      await initRedis();

      const numCPUs = os.cpus().length;
      console.log(`Primary process ${process.pid} is running`);
      console.log(`Forking ${numCPUs} worker processes...`);

      for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
      }

      cluster.on("exit", (worker, code, signal) => {
        console.log(`Worker process ${worker.process.pid} died. Restarting...`);
        cluster.fork();
      });
    })
    .catch((err) => {
      console.error("Database connection failed in Primary:", err.message);
      process.exit(1);
    });
} else {
  pool
    .query("SELECT NOW()")
    .then(async () => {
      console.log("Database connected successfully");
      await initializeDatabase();
      await initChatTables();
      await initRedis();

      // Use HTTPS if ssl options exist, else use HTTP
      const server = sslOptions
        ? https.createServer(sslOptions, app)
        : http.createServer(app);

      // Reattach socket.io to the server
      io.attach(server);
      server.listen(PORT, HOST, () => {
        console.log(
          ` Server running on port ${PORT} (${sslOptions ? "HTTPS" : "HTTP"}) [Worker ${process.pid}]`,
        );
      });
    })
    .catch((err) => {
      console.error(`Database connection failed in worker ${process.pid}:`, err.message);
      process.exit(1);
    });
}

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
}); // Trigger restart: 1
