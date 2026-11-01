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

async function recalculerPlaces(supabase, sessionId, capacite) {
  const { data, error } = await supabase
    .from("inscriptions")
    .select("id,est_abonne,date_demande")
    .eq("session_id", sessionId)
    .order("date_demande", { ascending: true });
  if (error) throw error;

  const classees = [...(data || [])].sort((a, b) => {
    const priorite = Number(b.est_abonne === true) - Number(a.est_abonne === true);
    return priorite || Number(a.date_demande || 0) - Number(b.date_demande || 0);
  });
  const misesAJour = await Promise.all(classees.map((inscription, index) =>
    supabase.from("inscriptions")
      .update({ statut: index < capacite ? "confirmed" : "waitlisted" })
      .eq("id", inscription.id)
  ));
  const erreurMaj = misesAJour.find(resultat => resultat.error)?.error;
  if (erreurMaj) throw erreurMaj;
  return new Map(classees.map((inscription, index) => [
    inscription.id,
    index < capacite ? "confirmed" : "waitlisted",
  ]));
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
        .select("id,debut_date,max_capacity,statut")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (!session) return json({ error: "Créneau introuvable." }, 404);
      if (session.statut === "annulee") return json({ error: "Ce créneau est annulé." }, 409);

      const dateDebut = new Date(session.debut_date).getTime();
      if (!Number.isFinite(dateDebut)) return json({ error: "Date de créneau invalide." }, 500);
      const avantH24 = Date.now() < dateDebut - 24 * 60 * 60 * 1000;
      if ((estInvite || !estAbonne) && avantH24) {
        return json({ error: "Les votes des non-adhérents et les invitations ouvrent exactement 24 heures avant le créneau." }, 409);
      }

      const { data: inscriptions, error: inscriptionsError } = await supabase
        .from("inscriptions")
        .select("id,session_id,prenom,nom,est_invite,invite_par_nom,statut")
        .eq("session_id", sessionId);
      if (inscriptionsError) throw inscriptionsError;

      if ((inscriptions || []).some(i => memeNom(i.prenom, i.nom, prenom, nom))) {
        return json({ error: "Cette personne est déjà inscrite sur ce créneau, y compris à l’essai ou par invitation." }, 409);
      }
      if (estInvite && (inscriptions || []).some(i =>
        i.est_invite && normaliser(i.invite_par_nom) === normaliser(inviteParNom)
      )) {
        return json({ error: "Un seul invité est autorisé par adhérent et par créneau." }, 409);
      }

      const capacite = Number(session.max_capacity) || 22;
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
          date_demande: Date.now(),
          reconfirme: false,
        })
        .select("id,statut")
        .single();
      if (insertError) throw insertError;
      const statuts = await recalculerPlaces(supabase, sessionId, capacite);
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
        .select("id,session_id,prenom,nom,est_invite,invite_par_nom")
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

      const { error: deleteError } = await supabase.from("inscriptions").delete().eq("id", id);
      if (deleteError) throw deleteError;
      const { data: session, error: sessionError } = await supabase
        .from("sessions")
        .select("max_capacity")
        .eq("id", inscription.session_id)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (session) await recalculerPlaces(supabase, inscription.session_id, Number(session.max_capacity) || 22);
      return json({ ok: true });
    }

    return json({ error: "Action inconnue." }, 400);
  } catch (error) {
    console.error("Erreur public-bookings :", error);
    return json({ error: "Impossible de traiter la demande." }, 500);
  }
});
