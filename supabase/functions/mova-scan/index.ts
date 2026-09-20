
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

function validateSelection(duration: number, goal: string) {
  if (![3,5,10].includes(duration)) return "Invalid duration";
  if (!["loosen_up","get_moving","get_stronger","whole_body"].includes(goal)) return "Invalid goal";
  return null;
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
