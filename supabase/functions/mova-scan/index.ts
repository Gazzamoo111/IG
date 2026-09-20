
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

async function sha256(v: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
}

function validUuid(v: unknown): v is string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function kitFromToken(token: string) {
  if (!token || token.length < 16 || token.length > 200) return null;
  const hash = await sha256(token);
  const { data, error } = await db.from("mova_kits")
    .select("id,kit_code,status,has_bar,has_handle_band,has_mini_band,fleet_id,site_id")
    .eq("token_hash", hash)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data;
}

function availableEquipment(kit: any) {
  const list: string[] = [];
  if (kit.has_bar) list.push("bar");
  if (kit.has_handle_band) list.push("handle_band");
  if (kit.has_mini_band) list.push("mini_band");
  list.push("bodyweight");
  return list;
}

function equipmentLabel(eq: string) {
  if (eq === "bar") return "MOVA Bar";
  if (eq === "handle_band") return "MOVA Handle Band";
  if (eq === "mini_band") return "MOVA Mini Band";
  return "No Kit";
}

async function touchDevice(deviceId: string) {
  const now = new Date().toISOString();
  const { error } = await db.from("mova_devices")
    .upsert({ id: deviceId, last_seen_at: now }, { onConflict: "id" });
  if (error) throw error;
}

async function logEvent(kitId: string, deviceId: string, type: string, data: any = {}, runId?: string) {
  const row: any = { kit_id: kitId, device_id: deviceId, event_type: type, data };
  if (runId) row.run_id = runId;
  const { error } = await db.from("mova_events").insert(row);
  if (error) throw error;
}

async function ownRun(runId: string, kitId: string, deviceId: string) {
  const { data, error } = await db.from("mova_session_runs")
    .select("id")
    .eq("id", runId)
    .eq("kit_id", kitId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function registerScan(kitId: string, deviceId: string) {
  const now = new Date().toISOString();
  const { data: link, error: readError } = await db.from("mova_kit_devices")
    .select("scan_count")
    .eq("kit_id", kitId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (readError) throw readError;

  if (link) {
    const { error } = await db.from("mova_kit_devices")
      .update({ scan_count: link.scan_count + 1, last_seen_at: now })
      .eq("kit_id", kitId)
      .eq("device_id", deviceId);
    if (error) throw error;
  } else {
    const { error } = await db.from("mova_kit_devices").insert({
      kit_id: kitId,
      device_id: deviceId,
      first_seen_at: now,
      last_seen_at: now,
      scan_count: 1
    });
    if (error) throw error;
  }
  await logEvent(kitId, deviceId, "scan");
}

async function pickEquipment(kit: any, deviceId: string, goal: string) {
  const available = availableEquipment(kit);
  const order: Record<string, string[]> = {
    loosen_up: ["handle_band", "mini_band", "bar", "bodyweight"],
    get_moving: ["mini_band", "handle_band", "bar", "bodyweight"],
    get_stronger: ["bar", "handle_band", "mini_band", "bodyweight"],
    whole_body: ["bar", "handle_band", "mini_band", "bodyweight"]
  };

  const ranked = (order[goal] || order.whole_body).filter(x => available.includes(x));
  const { data: recent } = await db.from("mova_session_runs")
    .select("equipment")
    .eq("device_id", deviceId)
    .eq("goal", goal)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (ranked.length > 1 && recent?.equipment === ranked[0]) return ranked[1];
  return ranked[0] || "bodyweight";
}

async function loadSteps(templateId: string) {
  const selectFields =
    "step_order,duration_seconds,transition_seconds,cue_override," +
    "movement:mova_movements!movement_id(id,code,name,short_cue,easier_name,easier_cue,demo_asset_url,easier_demo_asset_url)," +
    "alternate:mova_movements!alternate_movement_id(id,code,name,short_cue,demo_asset_url)";

  const { data, error } = await db.from("mova_session_steps")
    .select(selectFields)
    .eq("session_template_id", templateId)
    .order("step_order", { ascending: true });

  if (error) throw error;

  return (data || []).map((step: any) => ({
    order: step.step_order,
    duration_seconds: step.duration_seconds,
    transition_seconds: step.transition_seconds,
    name: step.movement?.name || "",
    cue: step.cue_override || step.movement?.short_cue || "",
    easier_name: step.movement?.easier_name || null,
    easier_cue: step.movement?.easier_cue || null,
    demo_asset_url: step.movement?.demo_asset_url || null,
    easier_demo_asset_url: step.movement?.easier_demo_asset_url || null,
    alternate: step.alternate ? {
      name: step.alternate.name,
      cue: step.alternate.short_cue,
      demo_asset_url: step.alternate.demo_asset_url
    } : null
  }));
}

async function templateFor(duration: number, goal: string, equipment: string) {
  const { data: template, error } = await db.from("mova_session_templates")
    .select("id,title,level,metadata")
    .eq("duration_minutes", duration)
    .eq("goal", goal)
    .eq("equipment", equipment)
    .eq("active", true)
    .order("level", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!template) return null;
  const steps = await loadSteps(template.id);
  const contentReady = Boolean(template.metadata?.content_status === "ready" && steps.length > 0);
  return { template, steps, contentReady };
}


async function offlinePackForKit(kit: any) {
  const available = availableEquipment(kit);
  const { data: templates, error: templateError } = await db.from("mova_session_templates")
    .select("id,title,level,metadata,duration_minutes,goal,equipment")
    .eq("active", true)
    .in("equipment", available)
    .order("duration_minutes", { ascending: true });

  if (templateError) throw templateError;
  const ids = (templates || []).map((t: any) => t.id);
  if (!ids.length) return [];

  const selectFields =
    "session_template_id,step_order,duration_seconds,transition_seconds,cue_override," +
    "movement:mova_movements!movement_id(id,code,name,short_cue,easier_name,easier_cue,demo_asset_url,easier_demo_asset_url)," +
    "alternate:mova_movements!alternate_movement_id(id,code,name,short_cue,demo_asset_url)";

  const { data: steps, error: stepsError } = await db.from("mova_session_steps")
    .select(selectFields)
    .in("session_template_id", ids)
    .order("step_order", { ascending: true });

  if (stepsError) throw stepsError;

  const grouped = new Map<string, any[]>();
  for (const step of steps || []) {
    const item = {
      order: step.step_order,
      duration_seconds: step.duration_seconds,
      transition_seconds: step.transition_seconds,
      name: step.movement?.name || "",
      cue: step.cue_override || step.movement?.short_cue || "",
      easier_name: step.movement?.easier_name || null,
      easier_cue: step.movement?.easier_cue || null,
      demo_asset_url: step.movement?.demo_asset_url || null,
      easier_demo_asset_url: step.movement?.easier_demo_asset_url || null,
      alternate: step.alternate ? {
        name: step.alternate.name,
        cue: step.alternate.short_cue,
        demo_asset_url: step.alternate.demo_asset_url
      } : null
    };
    if (!grouped.has(step.session_template_id)) grouped.set(step.session_template_id, []);
    grouped.get(step.session_template_id)!.push(item);
  }

  return (templates || []).map((template: any) => {
    const sessionSteps = grouped.get(template.id) || [];
    return {
      template_id: template.id,
      duration: template.duration_minutes,
      goal: template.goal,
      equipment: template.equipment,
      equipment_label: equipmentLabel(template.equipment),
      title: template.title,
      level: template.level || 1,
      content_ready: Boolean(template.metadata?.content_status === "ready" && sessionSteps.length > 0),
      steps: sessionSteps
    };
  });
}

function safeClientDate(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return fallback;
  const now = Date.now();
  if (ms > now + 5 * 60 * 1000 || ms < now - 7 * 24 * 60 * 60 * 1000) return fallback;
  return new Date(ms).toISOString();
}

async function syncOfflineSession(kit: any, deviceId: string, raw: any) {
  const runId = String(raw?.run_id || "");
  if (!validUuid(runId)) throw new Error("Invalid offline run");

  const { data: existing, error: existingError } = await db.from("mova_session_runs")
    .select("id,status")
    .eq("id", runId)
    .eq("kit_id", kit.id)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { ok: true, already_synced: true, run_id: existing.id };

  const duration = Number(raw?.duration);
  const goal = String(raw?.goal || "");
  const equipment = String(raw?.equipment || "");
  const status = String(raw?.status || "");
  const invalid = validateSelection(duration, goal);
  if (invalid) throw new Error(invalid);
  if (!["completed", "stopped"].includes(status)) throw new Error("Invalid offline session status");
  if (!availableEquipment(kit).includes(equipment)) throw new Error("Equipment is not available in this kit");

  const loaded = await templateFor(duration, goal, equipment);
  if (!loaded) throw new Error("Session not found");

  const nowIso = new Date().toISOString();
  const startedAt = safeClientDate(raw?.started_at, nowIso);
  const endedAt = safeClientDate(raw?.ended_at, nowIso);
  const elapsedRaw = Number(raw?.elapsed_seconds || 0);
  const elapsed = Number.isFinite(elapsedRaw)
    ? Math.max(0, Math.min(duration * 60, Math.round(elapsedRaw)))
    : 0;
  const feedback = ["too_easy", "about_right", "too_hard"].includes(String(raw?.feedback || ""))
    ? String(raw.feedback)
    : null;
  const skips = Array.isArray(raw?.skips) ? raw.skips.slice(0, 20) : [];

  const { error: runError } = await db.from("mova_session_runs").insert({
    id: runId,
    kit_id: kit.id,
    device_id: deviceId,
    session_template_id: loaded.template.id,
    duration_minutes: duration,
    goal,
    equipment,
    status,
    feedback,
    elapsed_seconds: elapsed,
    started_at: startedAt,
    completed_at: status === "completed" ? endedAt : null,
    metadata: {
      offline_synced: true,
      client_ended_at: endedAt,
      content_ready: loaded.contentReady
    }
  });
  if (runError) throw runError;

  await logEvent(kit.id, deviceId, "time_selected", { duration, offline_sync: true }, runId);
  await logEvent(kit.id, deviceId, "goal_selected", { duration, goal, offline_sync: true }, runId);
  await logEvent(
    kit.id,
    deviceId,
    "session_loaded",
    { equipment, template_id: loaded.template.id, content_ready: loaded.contentReady, offline_sync: true },
    runId
  );
  await logEvent(kit.id, deviceId, "session_started", { offline_sync: true }, runId);

  for (const skip of skips) {
    await logEvent(
      kit.id,
      deviceId,
      "movement_skipped",
      {
        movement_index: Math.max(0, Math.round(Number(skip?.movement_index || 0))),
        movement_label: String(skip?.movement_label || "").slice(0, 120),
        offline_sync: true
      },
      runId
    );
  }

  if (status === "completed") {
    await logEvent(kit.id, deviceId, "session_completed", { elapsed_seconds: elapsed, offline_sync: true }, runId);
  } else {
    await logEvent(kit.id, deviceId, "session_stopped", { elapsed_seconds: elapsed, offline_sync: true }, runId);
  }

  if (feedback) {
    await logEvent(kit.id, deviceId, "feedback_submitted", { feedback, offline_sync: true }, runId);
  }

  return { ok: true, run_id: runId };
}

function validateSelection(duration: number, goal: string) {
  if (![3,5,10].includes(duration)) return "Invalid duration";
  if (!["loosen_up","get_moving","get_stronger","whole_body"].includes(goal)) return "Invalid goal";
  return null;
}


const MOVA_TIMEZONE = "Pacific/Auckland";

function localDateKey(value: string | Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MOVA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function shiftDateKey(key: string, days: number) {
  const d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function mondayKeyFor(key: string) {
  const d = new Date(key + "T12:00:00Z");
  const day = d.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return shiftDateKey(key, offset);
}

async function deviceSummary(deviceId: string) {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 120);

  const [{ data: recent, error: recentError }, countResult] = await Promise.all([
    db.from("mova_session_runs")
      .select("id,status,duration_minutes,goal,equipment,elapsed_seconds,completed_at,created_at")
      .eq("device_id", deviceId)
      .in("status", ["completed", "stopped"])
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(500),
    db.from("mova_session_runs")
      .select("id", { count: "exact", head: true })
      .eq("device_id", deviceId)
      .eq("status", "completed")
  ]);

  if (recentError) throw recentError;
  if (countResult.error) throw countResult.error;

  const rows = recent || [];
  const activityRows = rows.filter((r: any) =>
    r.status === "completed" || Number(r.elapsed_seconds || 0) > 0
  );
  const nowKey = localDateKey(new Date());
  const mondayKey = mondayKeyFor(nowKey);
  const weekRows = activityRows.filter((r: any) => {
    const when = r.completed_at || r.created_at;
    const key = localDateKey(when);
    return key >= mondayKey && key <= nowKey;
  });

  const weekCompleted = weekRows.filter((r: any) => r.status === "completed");
  const weekMinutes = Math.round(
    weekRows.reduce((sum: number, r: any) => {
      const elapsed = Number(r.elapsed_seconds || 0);
      const seconds = r.status === "completed"
        ? (elapsed > 0 ? elapsed : Number(r.duration_minutes || 0) * 60)
        : elapsed;
      return sum + seconds;
    }, 0) / 60
  );

  const activeDayKeys = Array.from(new Set(
    weekRows.map((r: any) => localDateKey(r.completed_at || r.created_at))
  ));

  const allActiveDays = new Set(
    activityRows.map((r: any) => localDateKey(r.completed_at || r.created_at))
  );
  let streakKey = allActiveDays.has(nowKey) ? nowKey : shiftDateKey(nowKey, -1);
  let streakDays = 0;
  while (allActiveDays.has(streakKey) && streakDays < 120) {
    streakDays += 1;
    streakKey = shiftDateKey(streakKey, -1);
  }

  const goalCounts = new Map<string, number>();
  for (const r of weekCompleted) {
    if (!r.goal) continue;
    goalCounts.set(r.goal, (goalCounts.get(r.goal) || 0) + 1);
  }
  let favouriteGoal: string | null = null;
  let favouriteCount = 0;
  for (const [value, count] of goalCounts.entries()) {
    if (count > favouriteCount) {
      favouriteGoal = value;
      favouriteCount = count;
    }
  }

  const lastCompleted = rows.find((r: any) => r.status === "completed") || null;

  return {
    returning_user: rows.length > 0,
    week: {
      sessions: weekCompleted.length,
      movement_minutes: weekMinutes,
      active_days: activeDayKeys.length,
      streak_days: streakDays,
      favourite_goal: favouriteGoal
    },
    total_completed_sessions: Number(countResult.count || 0),
    last_session: lastCompleted ? {
      duration_minutes: lastCompleted.duration_minutes,
      goal: lastCompleted.goal,
      equipment: lastCompleted.equipment,
      completed_at: lastCompleted.completed_at || lastCompleted.created_at
    } : null
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const url = new URL(req.url);
    let body: any = {};
    if (req.method === "POST") body = await req.json().catch(() => ({}));

    const token = String(body.token || url.searchParams.get("t") || "");
    const kit = await kitFromToken(token);
    if (!kit) return json({ error: "Kit not recognised" }, 404);

    if (req.method === "GET") {
      return json({
        ok: true,
        kit: {
          code: kit.kit_code,
          equipment: {
            bar: kit.has_bar,
            handle_band: kit.has_handle_band,
            mini_band: kit.has_mini_band,
            bodyweight: true
          }
        }
      });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!validUuid(body.device_id)) return json({ error: "Invalid device" }, 400);

    const deviceId = body.device_id;
    await touchDevice(deviceId);
    const action = String(body.action || "");

    if (action === "scan") {
      await registerScan(kit.id, deviceId);
      const summary = await deviceSummary(deviceId);
      return json({
        ok: true,
        kit: {
          code: kit.kit_code,
          equipment: {
            bar: kit.has_bar,
            handle_band: kit.has_handle_band,
            mini_band: kit.has_mini_band,
            bodyweight: true
          }
        },
        summary
      });
    }

    if (action === "device_summary") {
      return json({ ok: true, summary: await deviceSummary(deviceId) });
    }

    if (action === "offline_pack") {
      const [sessions, summary] = await Promise.all([
        offlinePackForKit(kit),
        deviceSummary(deviceId)
      ]);
      return json({
        ok: true,
        generated_at: new Date().toISOString(),
        kit: {
          code: kit.kit_code,
          equipment: {
            bar: kit.has_bar,
            handle_band: kit.has_handle_band,
            mini_band: kit.has_mini_band,
            bodyweight: true
          }
        },
        summary,
        sessions
      });
    }

    if (action === "offline_session_sync") {
      const result = await syncOfflineSession(kit, deviceId, body.offline_session || {});
      return json(result);
    }

    if (action === "select_time") {
      const duration = Number(body.duration);
      if (![3,5,10].includes(duration)) return json({ error: "Invalid duration" }, 400);
      await logEvent(kit.id, deviceId, "time_selected", { duration });
      return json({ ok: true });
    }

    if (action === "preview_session") {
      const duration = Number(body.duration);
      const goal = String(body.goal || "");
      const equipment = String(body.equipment || "");
      const invalid = validateSelection(duration, goal);
      if (invalid) return json({ error: invalid }, 400);

      const available = availableEquipment(kit);
      if (!available.includes(equipment)) return json({ error: "Equipment is not available in this kit" }, 400);

      const loaded = await templateFor(duration, goal, equipment);
      if (!loaded) return json({ error: "Session not found" }, 404);

      return json({
        ok: true,
        duration,
        goal,
        equipment,
        equipment_label: equipmentLabel(equipment),
        title: loaded.template.title,
        level: loaded.template.level || 1,
        content_ready: loaded.contentReady,
        steps: loaded.contentReady ? loaded.steps : []
      });
    }

    if (action === "select_goal") {
      const duration = Number(body.duration);
      const goal = String(body.goal || "");
      const invalid = validateSelection(duration, goal);
      if (invalid) return json({ error: invalid }, 400);

      const available = availableEquipment(kit);
      let equipment = String(body.equipment || "");
      const requestedEquipment = equipment || null;

      if (equipment) {
        if (!available.includes(equipment)) return json({ error: "Equipment is not available in this kit" }, 400);
      } else {
        equipment = await pickEquipment(kit, deviceId, goal);
      }

      const loaded = await templateFor(duration, goal, equipment);
      if (!loaded) return json({ error: "Session not found" }, 404);

      const { data: run, error: runError } = await db.from("mova_session_runs").insert({
        kit_id: kit.id,
        device_id: deviceId,
        session_template_id: loaded.template.id,
        duration_minutes: duration,
        goal,
        equipment,
        status: "selected",
        metadata: {
          prototype: !loaded.contentReady,
          content_ready: loaded.contentReady,
          manual_equipment_selection: Boolean(requestedEquipment)
        }
      }).select("id").single();

      if (runError) throw runError;

      await logEvent(kit.id, deviceId, "goal_selected", { duration, goal }, run.id);
      if (requestedEquipment) {
        await logEvent(kit.id, deviceId, "equipment_switched", { equipment, duration }, run.id);
      }
      await logEvent(
        kit.id,
        deviceId,
        "session_loaded",
        { equipment, template_id: loaded.template.id, content_ready: loaded.contentReady },
        run.id
      );

      return json({
        ok: true,
        run_id: run.id,
        equipment,
        equipment_label: equipmentLabel(equipment),
        title: loaded.template.title,
        level: loaded.template.level || 1,
        content_ready: loaded.contentReady,
        steps: loaded.contentReady ? loaded.steps : []
      });
    }

    if (action === "session_started") {
      if (!validUuid(body.run_id)) return json({ error: "Invalid run" }, 400);
      const { data: run, error } = await db.from("mova_session_runs")
        .update({ status: "started", started_at: new Date().toISOString() })
        .eq("id", body.run_id)
        .eq("kit_id", kit.id)
        .eq("device_id", deviceId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!run) return json({ error: "Session not found" }, 404);
      await logEvent(kit.id, deviceId, "session_started", {}, body.run_id);
      return json({ ok: true });
    }

    if (action === "movement_skipped") {
      if (!validUuid(body.run_id)) return json({ error: "Invalid run" }, 400);
      const owned = await ownRun(body.run_id, kit.id, deviceId);
      if (!owned) return json({ error: "Session not found" }, 404);
      const movementIndex = Math.max(0, Math.round(Number(body.movement_index || 0)));
      const movementLabel = String(body.movement_label || "").slice(0, 120);
      await logEvent(
        kit.id,
        deviceId,
        "movement_skipped",
        { movement_index: movementIndex, movement_label: movementLabel },
        body.run_id
      );
      return json({ ok: true });
    }

    if (action === "session_stopped") {
      if (!validUuid(body.run_id)) return json({ error: "Invalid run" }, 400);
      const elapsed = Number(body.elapsed_seconds || 0);
      const safeElapsed = Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null;
      const { data: run, error } = await db.from("mova_session_runs")
        .update({
          status: "stopped",
          elapsed_seconds: safeElapsed
        })
        .eq("id", body.run_id)
        .eq("kit_id", kit.id)
        .eq("device_id", deviceId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!run) return json({ error: "Session not found" }, 404);
      await logEvent(
        kit.id,
        deviceId,
        "session_stopped",
        { elapsed_seconds: safeElapsed },
        body.run_id
      );
      return json({ ok: true });
    }

    if (action === "session_completed") {
      if (!validUuid(body.run_id)) return json({ error: "Invalid run" }, 400);
      const elapsed = Number(body.elapsed_seconds || 0);
      const { data: run, error } = await db.from("mova_session_runs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          elapsed_seconds: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null
        })
        .eq("id", body.run_id)
        .eq("kit_id", kit.id)
        .eq("device_id", deviceId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!run) return json({ error: "Session not found" }, 404);
      await logEvent(
        kit.id,
        deviceId,
        "session_completed",
        { elapsed_seconds: elapsed },
        body.run_id
      );
      return json({ ok: true });
    }

    if (action === "feedback") {
      if (!validUuid(body.run_id)) return json({ error: "Invalid run" }, 400);
      const feedback = String(body.feedback || "");
      if (!["too_easy","about_right","too_hard"].includes(feedback)) {
        return json({ error: "Invalid feedback" }, 400);
      }
      const { data: run, error } = await db.from("mova_session_runs")
        .update({ feedback })
        .eq("id", body.run_id)
        .eq("kit_id", kit.id)
        .eq("device_id", deviceId)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!run) return json({ error: "Session not found" }, 404);
      await logEvent(
        kit.id,
        deviceId,
        "feedback_submitted",
        { feedback },
        body.run_id
      );
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "MOVA backend error" }, 500);
  }
});
