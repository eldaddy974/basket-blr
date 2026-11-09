import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normaliser(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("fr-FR");
}

function memeNom(a, b, c, d) {
  return normaliser(a) === normaliser(c) && normaliser(b) === normaliser(d);
}

function obtenirCleSecrete() {
  const ancienneCle = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (ancienneCle) return ancienneCle;
  const keysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!keysJson) return null;
  try {
    return JSON.parse(keysJson).default || null;
  } catch {
    return null;
  }
}

async function recalculerPlaces(supabase, sessionId) {
  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("debut_date,max_capacity")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) return new Map();

  const dateDebut = new Date(session.debut_date).getTime();
  if (!Number.isFinite(dateDebut)) throw new Error("Date de créneau invalide.");
  const avantH24 = Date.now() < dateDebut - 24 * 60 * 60 * 1000;
  const capacite = Number(session.max_capacity) || 22;
  const { data, error } = await supabase
    .from("inscriptions")
    .select("id,est_abonne,admin_force_confirm,date_demande,statut")
    .eq("session_id", sessionId)
    .order("date_demande", { ascending: true });
  if (error) throw error;

  const classees = [...(data || [])].sort((a, b) => {
    const prioriteAdmin = Number(b.admin_force_confirm === true) - Number(a.admin_force_confirm === true);
    const prioriteAdhesion = Number(b.est_abonne === true) - Number(a.est_abonne === true);
    return prioriteAdmin || prioriteAdhesion || Number(a.date_demande || 0) - Number(b.date_demande || 0);
  });
  let nombrePlacesAttribuees = 0;
  const statuts = new Map();
  for (const inscription of classees) {
    const admissible = inscription.admin_force_confirm === true || inscription.est_abonne === true || !avantH24;
    const statut = admissible && nombrePlacesAttribuees < capacite ? "confirmed" : "waitlisted";
    if (statut === "confirmed") nombrePlacesAttribuees++;
    statuts.set(inscription.id, statut);
  }

  const misesAJour = await Promise.all(classees
    .filter(inscription => inscription.statut !== statuts.get(inscription.id))
    .map(inscription => supabase.from("inscriptions")
      .update({ statut: statuts.get(inscription.id) })
      .eq("id", inscription.id)));
  const erreurMaj = misesAJour.find(resultat => resultat.error)?.error;
  if (erreurMaj) throw erreurMaj;
  return statuts;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = obtenirCleSecrete();
    if (!supabaseUrl || !serviceKey) return json({ error: "Configuration serveur manquante." }, 500);

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const body = await req.json();
    const action = body?.action;

    if (action === "list") {
      const { data: sessions, error: sessionsError } = await supabase
        .from("sessions")
        .select("id")
        .order("debut_date", { ascending: true });
      if (sessionsError) throw sessionsError;
      for (const session of sessions || []) await recalculerPlaces(supabase, session.id);

      const { data, error } = await supabase
        .from("inscriptions")
        .select("id,session_id,prenom,nom,est_invite,invite_par_nom,statut,date_demande")
        .order("date_demande", { ascending: true });
      if (error) throw error;
      return json({ inscriptions: data || [] });
    }

    if (action === "register") {
      const sessionId = String(body?.session_id || "");
      const prenom = String(body?.prenom || "").trim();
      const nom = String(body?.nom || "").trim();
      const estInvite = body?.est_invite === true;
      const estAbonne = body?.est_abonne === true && !estInvite;
      const inviteParNom = String(body?.invite_par_nom || "").trim();

      if (!sessionId || !prenom || !nom || prenom.length > 80 || nom.length > 80) {
        return json({ error: "Renseigne un prénom et un nom valides." }, 400);
      }
      if (estInvite && !inviteParNom) return json({ error: "L’invité doit être rattaché à un adhérent." }, 400);

      const { data: session, error: sessionError } = await supabase
        .from("sessions")
        .select("id,nom,horaires,debut_date,max_capacity,statut")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (!session) return json({ error: "Créneau introuvable." }, 404);
      if (session.statut === "annulee") return json({ error: "Ce créneau est annulé." }, 409);

      const dateDebut = new Date(session.debut_date).getTime();
      if (!Number.isFinite(dateDebut)) return json({ error: "Date de créneau invalide." }, 500);

      const { data: inscriptions, error: inscriptionsError } = await supabase
        .from("inscriptions")
        .select("id,session_id,prenom,nom,est_invite,invite_par_nom,statut")
        .eq("session_id", sessionId);
      if (inscriptionsError) throw inscriptionsError;

      if ((inscriptions || []).some(i => memeNom(i.prenom, i.nom, prenom, nom))) {
        return json({ error: "Cette personne est déjà inscrite sur ce créneau, y compris à l’essai ou par invitation." }, 409);
      }
      const dateDemande = Date.now();
      const { data: inscription, error: insertError } = await supabase
        .from("inscriptions")
        .insert({
          session_id: sessionId,
          prenom,
          nom,
          est_invite: estInvite,
          invite_par_nom: estInvite ? inviteParNom : null,
          est_abonne: estAbonne,
          statut: "waitlisted",
          date_demande: dateDemande,
          reconfirme: false,
        })
        .select("id,statut")
        .single();
      if (insertError) throw insertError;
      const statuts = await recalculerPlaces(supabase, sessionId);
      const { error: eventError } = await supabase.from("inscription_evenements").insert({
        inscription_id: inscription.id,
        session_id: sessionId,
        session_nom: session.nom,
        session_debut_date: session.debut_date,
        session_horaires: session.horaires,
        prenom,
        nom,
        est_invite: estInvite,
        invite_par_nom: estInvite ? inviteParNom : null,
        est_abonne: estAbonne,
        type_evenement: "vote",
        statut: statuts.get(inscription.id) || inscription.statut,
        date_demande: dateDemande,
        acteur: estInvite ? inviteParNom : `${prenom} ${nom}`,
      });
      if (eventError) {
        const { error: rollbackError } = await supabase.from("inscriptions").delete().eq("id", inscription.id);
        if (rollbackError) console.error("Rollback du vote impossible :", rollbackError);
        else await recalculerPlaces(supabase, sessionId);
        throw eventError;
      }
      return json({ inscription: { ...inscription, statut: statuts.get(inscription.id) } });
    }

    if (action === "cancel") {
      const id = String(body?.id || "");
      const actorPrenom = String(body?.acteur_prenom || "").trim();
      const actorNom = String(body?.acteur_nom || "").trim();
      const adminPassword = String(body?.admin_password || "");
      const adminSecret = Deno.env.get("ADMIN_PASSWORD");
      const adminAuthorized = Boolean(adminSecret && adminPassword === adminSecret);
      if (!id) return json({ error: "Inscription introuvable." }, 400);

      const { data: inscription, error: findError } = await supabase
        .from("inscriptions")
        .select("id,session_id,prenom,nom,est_invite,invite_par_nom,est_abonne,statut,date_demande")
        .eq("id", id)
        .maybeSingle();
      if (findError) throw findError;
      if (!inscription) return json({ error: "Inscription déjà supprimée ou introuvable." }, 404);

      const acteurAutorise = inscription.est_invite
        ? normaliser(inscription.invite_par_nom) === normaliser(`${actorPrenom} ${actorNom}`)
        : memeNom(inscription.prenom, inscription.nom, actorPrenom, actorNom);
      if (!adminAuthorized && !acteurAutorise) {
        return json({ error: "Tu ne peux annuler que ton vote ou l’invité que tu as inscrit." }, 403);
      }

      const { data: sessionSnapshot, error: sessionSnapshotError } = await supabase
        .from("sessions")
        .select("nom,debut_date,horaires")
        .eq("id", inscription.session_id)
        .maybeSingle();
      if (sessionSnapshotError) throw sessionSnapshotError;

      const { data: annulationEvent, error: eventError } = await supabase
        .from("inscription_evenements")
        .insert({
          inscription_id: inscription.id,
          session_id: inscription.session_id,
          session_nom: sessionSnapshot?.nom || null,
          session_debut_date: sessionSnapshot?.debut_date || null,
          session_horaires: sessionSnapshot?.horaires || null,
          prenom: inscription.prenom,
          nom: inscription.nom,
          est_invite: inscription.est_invite === true,
          invite_par_nom: inscription.invite_par_nom || null,
          est_abonne: inscription.est_abonne === true,
          type_evenement: "annulation",
          statut: inscription.statut || null,
          date_demande: inscription.date_demande || null,
          acteur: `${actorPrenom} ${actorNom}`.trim() || null,
        })
        .select("id")
        .single();
      if (eventError) throw eventError;

      const { error: deleteError } = await supabase.from("inscriptions").delete().eq("id", id);
      if (deleteError) {
        const { error: rollbackError } = await supabase
          .from("inscription_evenements")
          .delete()
          .eq("id", annulationEvent.id);
        if (rollbackError) console.error("Rollback de l’annulation impossible :", rollbackError);
        throw deleteError;
      }
      await recalculerPlaces(supabase, inscription.session_id);
      return json({ ok: true });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (error) {
    console.error("Erreur public-bookings :", error);
    return json({ error: "Impossible de traiter la demande." }, 500);
  }
});
