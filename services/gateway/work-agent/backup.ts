/**
 * backup.ts — Automated backup orchestration for PostgreSQL, agent memory,
 * and WhatsApp auth state. Uploads to Google Drive via google-mcp-sidecar.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { McpClient } from "./mcp-client.js";
import { fetchWithTimeout } from "./utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text content from MCP tools/call result ({content: [{type, text}]}). */
function extractMcpText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as { content?: Array<{ type: string; text: string }> };
    if (Array.isArray(r.content)) {
      const item = r.content.find((c) => c.type === "text");
      if (item?.text) return item.text;
    }
  }
  return JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupConfig {
  dbUrl: string;
  workspaceDir: string;
  waUrl?: string;
  sidecarAuthToken?: string;
  account: string;
  retentionDays: number;
}

export interface DriveUploadResult {
  file_id: string;
  file_name: string;
  size_bytes: number;
  web_view_link: string;
}

export interface BackupStepResult {
  ok: boolean;
  file_name?: string;
  file_id?: string;
  size_bytes?: number;
  web_view_link?: string;
  error?: string;
}

export interface BackupResult {
  ok: boolean;
  timestamp: string;
  postgres?: BackupStepResult;
  memory?: BackupStepResult;
  whatsapp?: BackupStepResult;
  cleanup?: { deleted: number; error?: string };
  errors: string[];
}

// ---------------------------------------------------------------------------
// Individual backup steps
// ---------------------------------------------------------------------------

/** Dump PostgreSQL via pg_dump and gzip. Returns compressed buffer. */
export function backupPostgres(dbUrl: string): Buffer {
  return execSync(`pg_dump "${dbUrl}" | gzip`, {
    maxBuffer: 100 * 1024 * 1024, // 100MB
    timeout: 120_000, // 2 min
  });
}

/** Tar + gzip agent memory files (MEMORY.md + memory/). */
export function backupMemory(workspaceDir: string): Buffer | null {
  if (!existsSync(`${workspaceDir}/MEMORY.md`)) return null;

  // Build tar command — include memory/ dir only if it exists
  const parts = ["MEMORY.md"];
  if (existsSync(`${workspaceDir}/memory`)) parts.push("memory/");

  return execSync(`tar czf - -C "${workspaceDir}" ${parts.join(" ")}`, {
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30_000,
  });
}

/** Fetch WhatsApp auth state backup from WA sidecar. */
export async function fetchWhatsAppBackup(
  waUrl: string,
  authToken?: string,
): Promise<Buffer | null> {
  try {
    const hdrs: Record<string, string> = {};
    if (authToken) hdrs["X-Internal-Token"] = authToken;

    const res = await fetchWithTimeout(`${waUrl}/backup`, {
      method: "GET",
      headers: hdrs,
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      content_base64?: string | null;
      error?: string;
    };
    if (!data.content_base64) return null;

    return Buffer.from(data.content_base64, "base64");
  } catch (e) {
    console.error(`[backup] WA backup fetch failed: ${(e as Error).message}`);
    return null;
  }
}

/** Upload a buffer to Google Drive via MCP sidecar. */
export async function uploadToDrive(
  googleMcp: McpClient,
  fileName: string,
  content: Buffer,
  mimeType: string,
  account: string,
): Promise<DriveUploadResult> {
  const result = await googleMcp.call("drive_upload", {
    account,
    file_name: fileName,
    content_base64: content.toString("base64"),
    mime_type: mimeType,
  });

  // MCP tools/call wraps result in {content: [{type: "text", text: "..."}]}
  return JSON.parse(extractMcpText(result)) as DriveUploadResult;
}

/** Delete old backups beyond retention period. */
export async function cleanupOldBackups(
  googleMcp: McpClient,
  account: string,
  prefix: string,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffIso = cutoff.toISOString();

  // Search for backup files in the folder
  const searchResult = await googleMcp.call("drive_search_files", {
    account,
    query: `name contains '${prefix}' and modifiedTime < '${cutoffIso}' and trashed = false`,
    max_results: 50,
  });

  const parsed = JSON.parse(extractMcpText(searchResult)) as {
    files?: Array<{ id: string; name: string }>;
  };
  const files = parsed.files || [];

  let deleted = 0;
  for (const file of files) {
    try {
      await googleMcp.call("drive_delete", { account, file_id: file.id });
      deleted++;
      console.error(`[backup] Deleted old backup: ${file.name} (${file.id})`);
    } catch (e) {
      console.error(
        `[backup] Failed to delete ${file.name}: ${(e as Error).message}`,
      );
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Run full backup: postgres + memory + WA auth → upload → cleanup. */
export async function runBackup(config: BackupConfig, googleMcp: McpClient): Promise<BackupResult> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const result: BackupResult = {
    ok: true,
    timestamp,
    errors: [],
  };

  // 1. PostgreSQL backup
  try {
    console.error("[backup] Starting PostgreSQL dump...");
    const pgBuf = backupPostgres(config.dbUrl);
    const fileName = `backup-pg-${timestamp}.sql.gz`;
    const uploaded = await uploadToDrive(
      googleMcp,
      fileName,
      pgBuf,
      "application/gzip",
      config.account,
    );
    result.postgres = {
      ok: true,
      file_name: fileName,
      file_id: uploaded.file_id,
      size_bytes: pgBuf.length,
      web_view_link: uploaded.web_view_link,
    };
    console.error(
      `[backup] PostgreSQL: ${fileName} (${pgBuf.length} bytes) → ${uploaded.file_id}`,
    );
  } catch (e) {
    const msg = `PostgreSQL backup failed: ${(e as Error).message}`;
    result.errors.push(msg);
    result.postgres = { ok: false, error: msg };
    console.error(`[backup] ${msg}`);
  }

  // 2. Agent memory backup
  try {
    console.error("[backup] Starting memory backup...");
    const memBuf = backupMemory(config.workspaceDir);
    if (memBuf) {
      const fileName = `backup-memory-${timestamp}.tar.gz`;
      const uploaded = await uploadToDrive(
        googleMcp,
        fileName,
        memBuf,
        "application/gzip",
        config.account,
      );
      result.memory = {
        ok: true,
        file_name: fileName,
        file_id: uploaded.file_id,
        size_bytes: memBuf.length,
        web_view_link: uploaded.web_view_link,
      };
      console.error(
        `[backup] Memory: ${fileName} (${memBuf.length} bytes) → ${uploaded.file_id}`,
      );
    } else {
      result.memory = { ok: true, error: "no memory files found (skipped)" };
      console.error("[backup] Memory: no MEMORY.md found, skipping");
    }
  } catch (e) {
    const msg = `Memory backup failed: ${(e as Error).message}`;
    result.errors.push(msg);
    result.memory = { ok: false, error: msg };
    console.error(`[backup] ${msg}`);
  }

  // 3. WhatsApp auth state backup (non-critical)
  if (config.waUrl) {
    try {
      console.error("[backup] Fetching WhatsApp auth state...");
      const waBuf = await fetchWhatsAppBackup(
        config.waUrl,
        config.sidecarAuthToken,
      );
      if (waBuf) {
        const fileName = `backup-wa-auth-${timestamp}.tar.gz`;
        const uploaded = await uploadToDrive(
          googleMcp,
          fileName,
          waBuf,
          "application/gzip",
          config.account,
        );
        result.whatsapp = {
          ok: true,
          file_name: fileName,
          file_id: uploaded.file_id,
          size_bytes: waBuf.length,
          web_view_link: uploaded.web_view_link,
        };
        console.error(
          `[backup] WhatsApp: ${fileName} (${waBuf.length} bytes) → ${uploaded.file_id}`,
        );
      } else {
        result.whatsapp = {
          ok: true,
          error: "no auth state available (skipped)",
        };
        console.error("[backup] WhatsApp: no auth state, skipping");
      }
    } catch (e) {
      const msg = `WhatsApp backup failed: ${(e as Error).message}`;
      result.errors.push(msg);
      result.whatsapp = { ok: false, error: msg };
      console.error(`[backup] ${msg}`);
    }
  }

  // 4. Cleanup old backups
  try {
    console.error("[backup] Cleaning up old backups...");
    const deleted = await cleanupOldBackups(
      googleMcp,
      config.account,
      "backup-",
      config.retentionDays,
    );
    result.cleanup = { deleted };
    console.error(`[backup] Cleanup: deleted ${deleted} old backup(s)`);
  } catch (e) {
    const msg = `Cleanup failed: ${(e as Error).message}`;
    result.errors.push(msg);
    result.cleanup = { deleted: 0, error: msg };
    console.error(`[backup] ${msg}`);
  }

  result.ok = result.errors.length === 0;
  console.error(
    `[backup] Complete: ok=${result.ok}, errors=${result.errors.length}`,
  );
  return result;
}
