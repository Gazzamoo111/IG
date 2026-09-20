
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-mova-admin-key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, "0")).join("");
}

async function requireAdmin(req: Request) {
  const key = req.headers.get("x-mova-admin-key") || "";
  if (!key) return null;
  const keyHash = await sha256(key);
  const { data, error } = await db.from("mova_admin_keys")
    .select("id")
    .eq("key_hash", keyHash)
    .eq("active", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  await db.from("mova_admin_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);
  return data.id;
}

async function loadAdminData() {
  const [
    fleetsResult,
    sitesResult,
    kitsResult,
    templatesResult,
    specsResult,
    movementsResult,
    stepsResult,
    mediaResult
  ] = await Promise.all([
    db.from("mova_fleets").select("id,name,slug,status,created_at"),
    db.from("mova_sites").select("id,fleet_id,name,code,created_at"),
    db.from("mova_kits").select("id,fleet_id,site_id,kit_code,status,has_bar,has_handle_band,has_mini_band,issued_at,created_at"),
    db.from("mova_session_templates").select("id,code,duration_minutes,goal,equipment,level,title,active,content_version,metadata,created_at"),
    db.from("mova_equipment_specs").select("equipment_key,version,status,display_name,spec,updated_at"),
    db.from("mova_movements").select("id,code,equipment,name,short_cue,easier_name,easier_cue,demo_asset_url,easier_demo_asset_url,active,metadata,movement_pattern,difficulty,setup_cue,space_requirement,video_brief,created_at,updated_at"),
    db.from("mova_session_steps")
      .select("id,session_template_id,movement_id,step_order,duration_seconds,transition_seconds,alternate_movement_id,cue_override")
      .order("step_order", { ascending: true }),
    db.from("mova_media_assets")
      .select("id,movement_id,variant,status,storage_path,public_url,filename,mime_type,file_size_bytes,duration_seconds,aspect_ratio,loopable,version,notes,updated_at")
  ]);

  for (const r of [fleetsResult, sitesResult, kitsResult, templatesResult, specsResult, movementsResult, stepsResult, mediaResult]) {
    if (r.error) throw r.error;
  }

  const movements = movementsResult.data || [];
  const byId = new Map(movements.map((m: any) => [m.id, m]));
  const stepsByTemplate = new Map<string, any[]>();

  for (const step of stepsResult.data || []) {
    const movement: any = byId.get(step.movement_id);
    const alternate: any = step.alternate_movement_id ? byId.get(step.alternate_movement_id) : null;

    const item = {
      id: step.id,
      order: step.step_order,
      duration_seconds: step.duration_seconds,
      transition_seconds: step.transition_seconds,
      cue_override: step.cue_override,
      movement_code: movement?.code || "",
      movement_name: movement?.name || "",
      alternate_movement_code: alternate?.code || null,
      alternate_movement_name: alternate?.name || null
    };

    if (!stepsByTemplate.has(step.session_template_id)) {
      stepsByTemplate.set(step.session_template_id, []);
    }
    stepsByTemplate.get(step.session_template_id)!.push(item);
  }

  const templates = (templatesResult.data || [])
    .map((t: any) => ({
      id: t.id,
      code: t.code,
      duration_minutes: t.duration_minutes,
      goal: t.goal,
      equipment: t.equipment,
      level: t.level,
      title: t.title,
      active: t.active,
      content_version: t.content_version,
      status: t.metadata?.content_status || "draft",
      validation_status: t.metadata?.validation_status || null,
      metadata: t.metadata || {},
      steps: stepsByTemplate.get(t.id) || []
    }))
    .sort((a: any, b: any) =>
      a.duration_minutes - b.duration_minutes ||
      a.equipment.localeCompare(b.equipment) ||
      a.goal.localeCompare(b.goal)
    );

  const media = (mediaResult.data || [])
    .map((asset: any) => {
      const m: any = byId.get(asset.movement_id);
      return {
        ...asset,
        movement_code: m?.code || "",
        movement_name: m?.name || "",
        equipment: m?.equipment || "",
        easier_name: m?.easier_name || "",
        video_brief: m?.video_brief || ""
      };
    })
    .sort((a: any, b: any) =>
      a.equipment.localeCompare(b.equipment) ||
      a.movement_name.localeCompare(b.movement_name) ||
      a.variant.localeCompare(b.variant)
    );

  return {
    fleets: fleetsResult.data || [],
    sites: sitesResult.data || [],
    kits: kitsResult.data || [],
    equipment_specs: specsResult.data || [],
    movements,
    sessions: templates,
    media
  };
}

async function saveSession(body: any) {
  const sessionCode = String(body.session_code || "").trim();
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!sessionCode || steps.length < 1 || steps.length > 20) throw new Error("Invalid session");

  const { data: template, error: templateError } = await db.from("mova_session_templates")
    .select("id,code,duration_minutes,equipment,title,content_version,metadata")
    .eq("code", sessionCode)
    .maybeSingle();

  if (templateError) throw templateError;
  if (!template) throw new Error("Session not found");

  const codes = Array.from(new Set(steps.flatMap((s: any) => [
    String(s.movement_code || ""),
    s.alternate_movement_code ? String(s.alternate_movement_code) : ""
  ]).filter(Boolean)));

  const { data: movements, error: movementError } = await db.from("mova_movements")
    .select("id,code,equipment,active")
    .in("code", codes);

  if (movementError) throw movementError;

  const movementMap = new Map((movements || []).map((m: any) => [m.code, m]));
  let total = 0;

  const insertRows = steps.map((s: any, index: number) => {
    const movement: any = movementMap.get(String(s.movement_code || ""));
    if (!movement || !movement.active || movement.equipment !== template.equipment) {
      throw new Error("Movement equipment does not match session");
    }

    const altCode = s.alternate_movement_code ? String(s.alternate_movement_code) : null;
    const alt: any = altCode ? movementMap.get(altCode) : null;
    if (altCode && (!alt || !alt.active || alt.equipment !== template.equipment)) {
      throw new Error("Alternate movement equipment does not match session");
    }

    const durationSeconds = Math.round(Number(s.duration_seconds));
    const transitionSeconds = Math.round(Number(s.transition_seconds));

    if (!Number.isFinite(durationSeconds) || durationSeconds < 10 || durationSeconds > 180) {
      throw new Error("Invalid movement duration");
    }

    if (!Number.isFinite(transitionSeconds) || transitionSeconds < 0 || transitionSeconds > 30) {
      throw new Error("Invalid transition duration");
    }

    if (index === steps.length - 1 && transitionSeconds !== 0) {
      throw new Error("Last transition must be 0 seconds");
    }

    total += durationSeconds + transitionSeconds;

    return {
      session_template_id: template.id,
      movement_id: movement.id,
      step_order: index + 1,
      duration_seconds: durationSeconds,
      transition_seconds: transitionSeconds,
      alternate_movement_id: alt?.id || null,
      cue_override: s.cue_override ? String(s.cue_override).slice(0, 220) : null
    };
  });

  if (total !== template.duration_minutes * 60) {
    throw new Error("Session must total exactly " + (template.duration_minutes * 60) + " seconds");
  }

  const { error: deleteError } = await db.from("mova_session_steps")
    .delete()
    .eq("session_template_id", template.id);

  if (deleteError) throw deleteError;

  const { error: insertError } = await db.from("mova_session_steps").insert(insertRows);
  if (insertError) throw insertError;

  const metadata = {
    ...(template.metadata || {}),
    content_status: "ready",
    product_stage: "prototype",
    last_builder_save_at: new Date().toISOString()
  };

  const update: any = {
    content_version: Number(template.content_version || 1) + 1,
    metadata
  };

  if (body.title) update.title = String(body.title).slice(0, 120);

  const { error: updateError } = await db.from("mova_session_templates")
    .update(update)
    .eq("id", template.id);

  if (updateError) throw updateError;

  return { ok: true, code: sessionCode, total_seconds: total };
}

async function saveMovement(body: any) {
  const allowedEquipment = ["bar", "handle_band", "mini_band", "bodyweight"];
  const code = String(body.code || "").trim().toUpperCase();
  const equipment = String(body.equipment || "");
  const name = String(body.name || "").trim();
  const shortCue = String(body.short_cue || "").trim();
  const difficulty = Math.round(Number(body.difficulty || 1));

  if (!/^[A-Z0-9_-]{3,64}$/.test(code)) throw new Error("Invalid movement code");
  if (!allowedEquipment.includes(equipment)) throw new Error("Invalid equipment");
  if (!name || !shortCue) throw new Error("Movement name and cue are required");
  if (![1,2,3].includes(difficulty)) throw new Error("Invalid difficulty");

  const row = {
    code,
    equipment,
    name: name.slice(0, 120),
    short_cue: shortCue.slice(0, 220),
    easier_name: body.easier_name ? String(body.easier_name).slice(0, 120) : null,
    easier_cue: body.easier_cue ? String(body.easier_cue).slice(0, 220) : null,
    demo_asset_url: body.demo_asset_url ? String(body.demo_asset_url).slice(0, 500) : null,
    easier_demo_asset_url: body.easier_demo_asset_url ? String(body.easier_demo_asset_url).slice(0, 500) : null,
    active: body.active !== false,
    movement_pattern: body.movement_pattern ? String(body.movement_pattern).slice(0, 60) : null,
    difficulty,
    setup_cue: body.setup_cue ? String(body.setup_cue).slice(0, 300) : null,
    space_requirement: body.space_requirement ? String(body.space_requirement).slice(0, 40) : "small",
    video_brief: body.video_brief ? String(body.video_brief).slice(0, 800) : null,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : { product_stage: "prototype" },
    updated_at: new Date().toISOString()
  };

  const { error } = await db.from("mova_movements").upsert(row, { onConflict: "code" });
  if (error) throw error;

  const { data: movement } = await db.from("mova_movements")
    .select("id")
    .eq("code", code)
    .single();

  if (movement) {
    await db.from("mova_media_assets").upsert([
      {
        movement_id: movement.id,
        variant: "standard",
        status: "planned",
        aspect_ratio: "4:5",
        loopable: true
      },
      {
        movement_id: movement.id,
        variant: "easier",
        status: "planned",
        aspect_ratio: "4:5",
        loopable: true
      }
    ], {
      onConflict: "movement_id,variant",
      ignoreDuplicates: true
    });
  }

  return { ok: true, code };
}

async function uploadMedia(form: FormData) {
  const movementCode = String(form.get("movement_code") || "").trim().toUpperCase();
  const variant = String(form.get("variant") || "");
  const file = form.get("file");

  if (!["standard", "easier"].includes(variant)) throw new Error("Invalid media variant");
  if (!(file instanceof File)) throw new Error("Video file required");
  if (file.size <= 0 || file.size > 26214400) throw new Error("Video must be 25 MB or smaller");

  const mimeToExt: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov"
  };

  const ext = mimeToExt[file.type];
  if (!ext) throw new Error("Use MP4, WebM or MOV");

  const { data: movement, error: movementError } = await db.from("mova_movements")
    .select("id,code,equipment,name")
    .eq("code", movementCode)
    .maybeSingle();

  if (movementError) throw movementError;
  if (!movement) throw new Error("Movement not found");

  const { data: existing, error: assetError } = await db.from("mova_media_assets")
    .select("id,version")
    .eq("movement_id", movement.id)
    .eq("variant", variant)
    .maybeSingle();

  if (assetError) throw assetError;

  const version = Number(existing?.version || 1);
  const path =
    movement.equipment + "/" +
    movement.code.toLowerCase() + "/" +
    variant + "_v" + version + "." + ext;

  const { error: uploadError } = await db.storage
    .from("mova-media")
    .upload(path, file, {
      contentType: file.type,
      upsert: true,
      cacheControl: "3600"
    });

  if (uploadError) throw uploadError;

  const { data: publicData } = db.storage
    .from("mova-media")
    .getPublicUrl(path);

  const publicUrl = publicData.publicUrl;

  const row = {
    movement_id: movement.id,
    variant,
    status: "uploaded",
    storage_path: path,
    public_url: publicUrl,
    filename: file.name,
    mime_type: file.type,
    file_size_bytes: file.size,
    aspect_ratio: "4:5",
    loopable: true,
    version,
    updated_at: new Date().toISOString()
  };

  const { error: saveError } = await db.from("mova_media_assets")
    .upsert(row, { onConflict: "movement_id,variant" });

  if (saveError) throw saveError;

  return {
    ok: true,
    movement_code: movement.code,
    variant,
    public_url: publicUrl,
    status: "uploaded"
  };
}

async function approveMedia(body: any) {
  const movementCode = String(body.movement_code || "").trim().toUpperCase();
  const variant = String(body.variant || "");

  if (!["standard", "easier"].includes(variant)) throw new Error("Invalid media variant");

  const { data: movement, error: movementError } = await db.from("mova_movements")
    .select("id,code")
    .eq("code", movementCode)
    .maybeSingle();

  if (movementError) throw movementError;
  if (!movement) throw new Error("Movement not found");

  const { data: asset, error: assetError } = await db.from("mova_media_assets")
    .select("id,public_url,status")
    .eq("movement_id", movement.id)
    .eq("variant", variant)
    .maybeSingle();

  if (assetError) throw assetError;
  if (!asset?.public_url) throw new Error("Upload a video first");

  const { error: approveError } = await db.from("mova_media_assets")
    .update({
      status: "approved",
      updated_at: new Date().toISOString()
    })
    .eq("id", asset.id);

  if (approveError) throw approveError;

  const field = variant === "standard" ? "demo_asset_url" : "easier_demo_asset_url";

  const { error: movementUpdateError } = await db.from("mova_movements")
    .update({
      [field]: asset.public_url,
      updated_at: new Date().toISOString()
    })
    .eq("id", movement.id);

  if (movementUpdateError) throw movementUpdateError;

  return {
    ok: true,
    movement_code: movementCode,
    variant,
    status: "approved",
    public_url: asset.public_url
  };
}


function mixPercent(rows: any[], key: string, labels: Record<string,string> = {}) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = String(row[key] || "");
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  if (!total) return [];
  return Array.from(counts.entries())
    .map(([value, count]) => ({
      label: labels[value] || value,
      value: Math.round((count / total) * 100)
    }))
    .sort((a, b) => b.value - a.value);
}

async function loadLiveFleetData(fleetSlug?: string | null) {
  let fleetQuery = db.from("mova_fleets")
    .select("id,name,slug,status,driver_population")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1);

  if (fleetSlug) {
    fleetQuery = db.from("mova_fleets")
      .select("id,name,slug,status,driver_population")
      .eq("slug", fleetSlug)
      .eq("status", "active")
      .limit(1);
  }

  const { data: fleets, error: fleetError } = await fleetQuery;
  if (fleetError) throw fleetError;
  const fleet = fleets?.[0];
  if (!fleet) throw new Error("Fleet not found");

  const [{ data: sites, error: sitesError }, { data: kits, error: kitsError }] = await Promise.all([
    db.from("mova_sites")
      .select("id,name,code,driver_population")
      .eq("fleet_id", fleet.id)
      .order("name"),
    db.from("mova_kits")
      .select("id,site_id,kit_code,status")
      .eq("fleet_id", fleet.id)
      .eq("status", "active")
  ]);
  if (sitesError) throw sitesError;
  if (kitsError) throw kitsError;

  const kitIds = (kits || []).map((k: any) => k.id);
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 6);

  let runs: any[] = [];
  let kitDevices: any[] = [];
  if (kitIds.length) {
    const [runsResult, devicesResult] = await Promise.all([
      db.from("mova_session_runs")
        .select("id,kit_id,device_id,duration_minutes,goal,equipment,elapsed_seconds,completed_at")
        .in("kit_id", kitIds)
        .eq("status", "completed")
        .gte("completed_at", start.toISOString())
        .lte("completed_at", now.toISOString()),
      db.from("mova_kit_devices")
        .select("kit_id,device_id")
        .in("kit_id", kitIds)
    ]);
    if (runsResult.error) throw runsResult.error;
    if (devicesResult.error) throw devicesResult.error;
    runs = runsResult.data || [];
    kitDevices = devicesResult.data || [];
  }

  const activatedDevices = new Set(kitDevices.map((x: any) => x.device_id));
  const population = Number(fleet.driver_population || 0) || null;
  const activationRate = population
    ? Math.round((activatedDevices.size / population) * 100)
    : null;

  const completedByDevice = new Map<string, number>();
  for (const run of runs) {
    completedByDevice.set(run.device_id, (completedByDevice.get(run.device_id) || 0) + 1);
  }
  const completingDevices = Array.from(completedByDevice.keys());
  const repeatUsers = completingDevices.filter(id => (completedByDevice.get(id) || 0) > 1).length;
  const repeatRate = completingDevices.length
    ? Math.round((repeatUsers / completingDevices.length) * 100)
    : 0;

  const movementMinutes = Math.round(
    runs.reduce((sum, run) => sum + (Number(run.elapsed_seconds || 0) || Number(run.duration_minutes || 0) * 60), 0) / 60
  );

  const dateBuckets = new Map<string, number>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    dateBuckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const run of runs) {
    const key = String(run.completed_at || "").slice(0, 10);
    if (dateBuckets.has(key)) dateBuckets.set(key, (dateBuckets.get(key) || 0) + 1);
  }
  const weeklySessions = Array.from(dateBuckets.entries()).map(([date, value]) => ({
    day: new Intl.DateTimeFormat("en-NZ", { weekday: "short", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z")),
    value
  }));

  const kitToSite = new Map((kits || []).map((k: any) => [k.id, k.site_id]));
  const siteDevices = new Map<string, Set<string>>();
  const siteSessions = new Map<string, number>();
  for (const site of sites || []) {
    siteDevices.set(site.id, new Set());
    siteSessions.set(site.id, 0);
  }
  for (const row of kitDevices) {
    const siteId = kitToSite.get(row.kit_id);
    if (siteId && siteDevices.has(siteId)) siteDevices.get(siteId)!.add(row.device_id);
  }
  for (const run of runs) {
    const siteId = kitToSite.get(run.kit_id);
    if (siteId && siteSessions.has(siteId)) siteSessions.set(siteId, (siteSessions.get(siteId) || 0) + 1);
  }

  return {
    ok: true,
    data_mode: "live",
    fleet: {
      name: fleet.name,
      period: "Last 7 days",
      metrics: {
        drivers: population,
        activated: activatedDevices.size,
        activation_rate: activationRate,
        sessions_this_week: runs.length,
        repeat_users_rate: repeatRate,
        movement_minutes: movementMinutes
      },
      duration_mix: mixPercent(runs, "duration_minutes", {
        "3": "3 min",
        "5": "5 min",
        "10": "10 min"
      }),
      goals: mixPercent(runs, "goal", {
        loosen_up: "Loosen Up",
        get_moving: "Get Moving",
        get_stronger: "Get Stronger",
        whole_body: "Whole Body"
      }),
      equipment: mixPercent(runs, "equipment", {
        bar: "MOVA Bar",
        handle_band: "Handle Band",
        mini_band: "Mini Band",
        bodyweight: "No Kit"
      }),
      weekly_sessions: weeklySessions,
      sites: (sites || []).map((site: any) => {
        const sitePopulation = Number(site.driver_population || 0) || null;
        const active = siteDevices.get(site.id)?.size || 0;
        return {
          name: site.name,
          activation: sitePopulation ? Math.round((active / sitePopulation) * 100) : null,
          sessions: siteSessions.get(site.id) || 0
        };
      })
    }
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      if (url.searchParams.get("key") !== "mova_console_demo_v1") {
        return json({ error: "Not authorised" }, 401);
      }

      const mode = url.searchParams.get("mode") || "fleet";
      const source = url.searchParams.get("source") || "demo";

      if (mode === "fleet" && source === "live") {
        return json(await loadLiveFleetData(url.searchParams.get("fleet")));
      }

      const data = await loadAdminData();

      if (mode === "admin") {
        return json({
          ok: true,
          data_mode: "prototype",
          summary: {
            fleets: data.fleets.length,
            sites: data.sites.length,
            kits: data.kits.length,
            session_templates: data.sessions.length,
            ready_sessions: data.sessions.filter((s: any) => s.status === "ready").length,
            movement_records: data.movements.filter((m: any) => m.active).length,
            media_slots: data.media.length,
            media_approved: data.media.filter((m: any) => m.status === "approved").length
          },
          fleets: data.fleets.map((f: any) => ({
            name: f.name,
            slug: f.slug,
            status: f.status
          })),
          kits: data.kits.map((k: any) => ({
            code: k.kit_code,
            status: k.status,
            equipment: {
              bar: k.has_bar,
              handle_band: k.has_handle_band,
              mini_band: k.has_mini_band
            }
          })),
          equipment_specs: data.equipment_specs,
          movements: data.movements,
          sessions: data.sessions,
          media: data.media,
          media_guidelines: {
            aspect_ratio: "4:5",
            target_resolution: "1080x1350",
            frame_rate: "30 fps",
            target_clip_length: "6-10 seconds",
            audio: "none / muted",
            loop: "seamless where practical",
            framing: "full body with all equipment and feet visible",
            style: "single demonstrator, clean neutral background, work-ready clothing, no text baked into video",
            camera: "locked-off camera; front three-quarter default, side or front where movement clarity requires it",
            coaching: "coaching cue remains in the MOVA UI, not inside the video",
            naming: "equipment/movement_code/standard_v1.mp4 and easier_v1.mp4"
          }
        });
      }

      return json({
        ok: true,
        data_mode: "prototype_demo",
        fleet: {
          name: "MOVA Pilot Fleet",
          period: "Last 7 days",
          metrics: {
            drivers: 142,
            activated: 98,
            activation_rate: 69,
            sessions_this_week: 284,
            repeat_users_rate: 63,
            movement_minutes: 1286
          },
          duration_mix: [
            { label: "3 min", value: 47 },
            { label: "5 min", value: 38 },
            { label: "10 min", value: 15 }
          ],
          goals: [
            { label: "Loosen Up", value: 31 },
            { label: "Get Moving", value: 24 },
            { label: "Get Stronger", value: 29 },
            { label: "Whole Body", value: 16 }
          ],
          equipment: [
            { label: "MOVA Bar", value: 34 },
            { label: "Handle Band", value: 31 },
            { label: "Mini Band", value: 27 },
            { label: "No Kit", value: 8 }
          ],
          weekly_sessions: [
            { day: "Mon", value: 39 },
            { day: "Tue", value: 46 },
            { day: "Wed", value: 41 },
            { day: "Thu", value: 53 },
            { day: "Fri", value: 48 },
            { day: "Sat", value: 31 },
            { day: "Sun", value: 26 }
          ],
          sites: [
            { name: "Hamilton Depot", activation: 74, sessions: 122 },
            { name: "Auckland Depot", activation: 67, sessions: 101 },
            { name: "Tauranga Depot", activation: 61, sessions: 61 }
          ]
        }
      });
    }

    if (req.method === "POST") {
      const adminId = await requireAdmin(req);
      if (!adminId) return json({ error: "Admin key required" }, 401);

      const contentType = req.headers.get("content-type") || "";

      if (contentType.includes("multipart/form-data")) {
        const form = await req.formData();
        if (String(form.get("action") || "") !== "upload_media") {
          return json({ error: "Unknown upload action" }, 400);
        }
        return json(await uploadMedia(form));
      }

      const body = await req.json().catch(() => ({}));
      const action = String(body.action || "");

      if (action === "save_session") return json(await saveSession(body));
      if (action === "save_movement") return json(await saveMovement(body));
      if (action === "approve_media") return json(await approveMedia(body));
      if (action === "verify_admin") return json({ ok: true });

      return json({ error: "Unknown admin action" }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error(error);
    return json({
      error: error instanceof Error ? error.message : "MOVA console error"
    }, 500);
  }
});
