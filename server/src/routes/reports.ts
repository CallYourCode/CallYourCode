/* A BUG REPORT, WITH THE LOG ATTACHED, from the device that has the bug.
 *
 * This is not /clientlog with a sentence on it, and the difference is the
 * whole feature. /clientlog is a stream the page ships continuously and
 * GIVES UP ON after five consecutive failures -- so at the moment most
 * worth reporting, when the app server was unreachable, the mac has none of
 * those lines. The page therefore keeps its own ring and hands over a
 * snapshot of it here, along with the anchors nobody can reconstruct
 * afterwards: the build, the device, the page load, the open chat, the
 * correlation ids in the tail, and the time HE pressed the button.
 *
 * IT ANSWERS WITH THE ID IT MINTED, and the page treats a 200 without one
 * as a refusal. That is the contract that lets the app say "sent" only when
 * something is really on this disk, which is the recurring defect class
 * (the app asserting what it does not know) in its most costly shape: he
 * would believe a bug had been filed.
 *
 * OVERSIZE IS TRUNCATED, NOT REFUSED, and the stored file says which caps
 * bit. Half the evidence beats a refusal at the one moment somebody was
 * trying to tell us something. */

import { join } from "node:path";
import { safeCid } from "../../../engine/shared/logbook.ts";
import { mkdirPrivate, writePrivate } from "../../../engine/shared/runfiles.ts";
import { json, type LogFn } from "../platform/httpx";
import { reportId, reportPath, reportText, reportFiles, reapReports } from "../reports/reports";
import { REPORT_MAX_BYTES, REPORT_MAX_LINES, REPORT_MAX_CHARS, REPORT_TEXT_MAX } from "../platform/caps";

export type ReportsDeps = {
  deviceOwner(req: Request): Promise<{ reportsDir: string } | null>;
  log: LogFn;
};

export function makeReportRoutes(deps: ReportsDeps) {
  return async (req: Request, path: string): Promise<Response | null> => {
    if (path === "/report" && req.method === "POST") {
      const store = await deps.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const raw = await req.arrayBuffer().catch(() => null);
      if (!raw) return json({ error: "no body" }, 400);
      if (raw.byteLength > REPORT_MAX_BYTES) {
        deps.log("report.refused", { bytes: raw.byteLength, cap: REPORT_MAX_BYTES,
          why: "the POST is larger than any report this page can produce" });
        return json({ error: "too large", cap: REPORT_MAX_BYTES }, 413);
      }
      let body: any = null;
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* below */ }
      if (!body || typeof body !== "object") return json({ error: "bad body" }, 400);

      const text = reportText(body.text, REPORT_TEXT_MAX);
      /* NO WORDS, NO REPORT. A log dump with no question in it is not a lead,
       * and storing one would put a file in the triage directory that can only
       * ever be deleted. The page refuses first; this is the second wall. */
      if (!text.trim()) return json({ error: "empty report" }, 400);

      const all: unknown[] = Array.isArray(body.lines) ? body.lines : [];
      const lines = all.slice(-REPORT_MAX_LINES)
        .map((l) => reportText(l, REPORT_MAX_CHARS))
        .filter((l) => l.trim());
      const cids = (Array.isArray(body.cids) ? body.cids : [])
        .map((c: unknown) => safeCid(c)).filter(Boolean).slice(0, 10);

      const id = reportId();
      const stored = {
        id,
        /* WHEN HE PRESSED IT, and separately when it got here. They differ by
         * however long the app server was unreachable, and that gap is itself
         * the answer to some of these reports. */
        at: reportText(body.at, 40) || new Date().toISOString(),
        received: new Date().toISOString(),
        text,
        /* The two ids every line in `lines` carries, so a report joins to
         * whatever DID reach .run/logs/app.log by the ordinary route. */
        device: safeCid(body.device) || "?",
        page: safeCid(body.page) || "?",
        build: reportText(body.build, 200),
        ua: reportText(body.ua, 300),
        screen: reportText(body.screen, 40),
        session: body.session && typeof body.session === "object" ? {
          id: reportText((body.session as any).id, 200),
          title: reportText((body.session as any).title, 200),
        } : null,
        engine: body.engine && typeof body.engine === "object" ? {
          state: reportText((body.engine as any).state, 40),
          key: reportText((body.engine as any).key, 200),
        } : null,
        ship: body.ship && typeof body.ship === "object" ? body.ship : null,
        /* WHAT TO HAND scripts/journey.sh. The ids are read off the lines by
         * the page; this stores them beside the log rather than making whoever
         * opens the file grep for them. */
        cids,
        lines,
        /* SAID, NOT IMPLIED. A report that was cut down must say so, or the
         * absence of the line you were looking for reads as the event not
         * having happened. */
        truncated: all.length > lines.length ? { sentLines: all.length, keptLines: lines.length } : null,
      };

      try {
        await mkdirPrivate(store.reportsDir);
        await writePrivate(join(store.reportsDir, `${id}.json`), JSON.stringify(stored, null, 2));
      } catch (e) {
        /* NOTHING WAS STORED, so nothing is claimed. The page keeps the report
         * in its outbox and retries; answering ok here would lose it. */
        deps.log("report.failed", { id, dev: stored.device, err: String(e) });
        return json({ error: "could not store" }, 500);
      }
      const reaped = await reapReports(store.reportsDir);
      deps.log("report.filed", { id, dev: stored.device, pg: stored.page,
        build: stored.build, session: stored.session?.id, engine: stored.engine?.state,
        lines: lines.length, cids: cids.join(","), reaped,
        text: text.slice(0, 120) });
      return json({ ok: true, id });
    }

    /* THE PULL SIDE, until there is a triage screen: the list, and one report.
     *
     * The list carries no `lines`, because it is a list -- a few hundred
     * reports each with four hundred log lines is not something anybody wants
     * in one response. GET /reports/<id> is the whole file. */
    if (path === "/reports" && req.method === "GET") {
      const store = await deps.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const files = await reportFiles(store.reportsDir);
      const out: unknown[] = [];
      for (const f of files.slice(0, 100)) {
        const j = await Bun.file(join(store.reportsDir, f)).json().catch(() => null) as any;
        if (!j) continue;
        const { lines, ...rest } = j;
        out.push({ ...rest, lines: Array.isArray(lines) ? lines.length : 0 });
      }
      return json({ reports: out, total: files.length, dir: store.reportsDir });
    }

    if (path.startsWith("/reports/") && req.method === "GET") {
      const store = await deps.deviceOwner(req);
      if (!store) return json({ error: "unauthorized" }, 401);
      const p = reportPath(store.reportsDir, path.slice("/reports/".length));
      if (!p) return json({ error: "bad id" }, 400);
      const j = await Bun.file(p).json().catch(() => null);
      return j ? json(j) : json({ error: "not found" }, 404);
    }

    return null;
  };
}
